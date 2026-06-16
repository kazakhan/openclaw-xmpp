import { xml } from "@xmpp/client";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { parseVCard } from "./lib/vcard-protocol.js";
import { safeSend } from "./lib/xmpp-utils.js";
import { debugLog } from "./shared/index.js";
import { child } from "./lib/logger.js";

const xmppLog = child("vcard-server");

export interface VCardServerDeps {
  xmpp: any;
  bareJid: string;
}

export function createVCardServer(deps: VCardServerDeps) {
  const { xmpp, bareJid } = deps;

  const queryVCardFromServer = async (targetJid: string): Promise<any> => {
    const id = `vc-get-${Date.now()}`;
    let response: any = null;
    let error: any = null;
    
    const handler = (stanza: any) => {
      debugLog(`vCard query received stanza: id=${stanza.attrs.id}, type=${stanza.attrs.type}, from=${stanza.attrs.from}`);
      if (stanza.attrs.id === id && stanza.attrs.type === 'result') {
        response = stanza;
      }
    };
    
    xmpp.on('stanza', handler);
    
    try {
      const iqAttrs: any = { type: "get", id };
      if (targetJid) {
        iqAttrs.to = targetJid;
      }
      debugLog(`Querying vCard from ${targetJid || 'self'} with id ${id}`);
      await safeSend(xmpp, xml("iq", iqAttrs, xml("vCard", { xmlns: "vcard-temp" })));
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (err) {
      error = err;
      debugLog(`vCard query send error: ${err}`);
    } finally {
      xmpp.off('stanza', handler);
    }
    
    if (error) {
      debugLog(`vCard query error: ${error}`);
      return null;
    }
    
    if (response) {
      const vcardEl = response.getChild('vCard');
      xmppLog.debug("vCard query response received");
      if (vcardEl) {
        const data = parseVCard(vcardEl);
        debugLog(`vCard parsed: fn=${data.fn}, nickname=${data.nickname}, avatarUrl=${data.avatarUrl}`);
        return data;
      }
    }
    debugLog(`vCard query no response for ${targetJid || 'self'}`);
    return null;
  };
  
  const updateVCardOnServer = async (updates: any): Promise<boolean> => {
    const current = await queryVCardFromServer('');
    const merged = current ? { ...current, ...updates } : updates;
    
    const vcardId = `vc-set-${Date.now()}`;
    let responseReceived = false;
    let updateSuccess = false;
    
    const handler = (stanza: any) => {
      xmppLog.debug("vCard update stanza", { id: stanza.attrs.id, type: stanza.attrs.type });
      if (stanza.attrs.id === vcardId) {
        if (stanza.attrs.type === 'result') {
          updateSuccess = true;
        } else if (stanza.attrs.type === 'error') {
          xmppLog.error("vCard update error");
        }
        responseReceived = true;
      }
    };
    
    xmpp.on('stanza', handler);
    
    const vcardSet = xml("iq", { type: "set", id: vcardId },
      xml("vCard", { xmlns: "vcard-temp" },
        merged.fn ? xml("FN", {}, merged.fn) : null,
        merged.nickname ? xml("NICKNAME", {}, merged.nickname) : null,
        merged.url ? xml("URL", {}, merged.url) : null,
        merged.desc ? xml("DESC", {}, merged.desc) : null,
        (merged.avatarBinval || merged.avatarUrl) ? xml("PHOTO", {}, 
          merged.avatarType ? xml("TYPE", {}, merged.avatarType) : null,
          merged.avatarBinval ? xml("BINVAL", {}, merged.avatarBinval) : null,
          merged.avatarUrl ? xml("EXTVAL", {}, merged.avatarUrl) : null
        ) : null
      )
    );
    
    try {
      xmppLog.debug("vCard update sending", { id: vcardId });
      await safeSend(xmpp, vcardSet);
      
      let waited = 0;
      while (!responseReceived && waited < 5000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        waited += 100;
      }
      
      if (!responseReceived) {
        xmppLog.warn("vCard update timeout");
      }
      
      return updateSuccess;
    } catch (err) {
      xmppLog.error("vCard update send failed", err);
      return false;
    } finally {
      xmpp.off('stanza', handler);
    }
  };

  const publishAvatar = async (filePath: string, imageUrl: string): Promise<boolean> => {
    try {
      const fileBuffer = await fs.readFile(filePath);
      const hash = crypto.createHash('sha1').update(fileBuffer).digest('hex');
      const size = fileBuffer.length;
      
      const ext = path.extname(filePath).toLowerCase();
      let mimeType = 'image/jpeg';
      if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.gif') mimeType = 'image/gif';
      else if (ext === '.webp') mimeType = 'image/webp';
       
       xmppLog.debug("avatar", { action: "publishing", size, type: mimeType });
      
      const retractId = `avatar-retract-${Date.now()}`;
      const retractStanza = xml("iq", { type: "set", to: bareJid, id: retractId },
        xml("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" },
          xml("retract", { node: "urn:xmpp:avatar:metadata" },
            xml("item", { id: hash })
          )
        )
      );
      
      const metadataId = `avatar-meta-${Date.now()}`;
      const metadataStanza = xml("iq", { type: "set", to: bareJid, id: metadataId },
        xml("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" },
          xml("publish", { node: "urn:xmpp:avatar:metadata" },
            xml("item", { id: hash },
              xml("metadata", { xmlns: "urn:xmpp:avatar:metadata" },
                xml("info", { 
                  bytes: size.toString(), 
                  id: hash, 
                  type: mimeType
                })
              )
            )
          )
        )
      );
      
      await safeSend(xmpp, metadataStanza);
       
      const dataId = `avatar-data-${Date.now()}`;
      const base64Data = fileBuffer.toString('base64');
      const dataStanza = xml("iq", { type: "set", to: bareJid, id: dataId },
        xml("pubsub", { xmlns: "http://jabber.org/protocol/pubsub" },
          xml("publish", { node: "urn:xmpp:avatar:data" },
            xml("item", { id: hash },
              xml("data", { xmlns: "urn:xmpp:avatar:data" }, base64Data)
            )
          )
        )
      );
      
      await safeSend(xmpp, dataStanza);
       
       return true;
    } catch (err) {
      xmppLog.error("PEP avatar publish failed", err);
      return false;
    }
  };

  return { queryVCardFromServer, updateVCardOnServer, publishAvatar };
}
