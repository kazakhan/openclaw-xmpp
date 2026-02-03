import fs from "fs";
import path from "path";
import { xml } from "@xmpp/client";
import { UploadSlot } from "./types.js";

export interface FileTransferOptions {
  xmpp: any;
  domain: string;
  dataDir: string;
}

export function createFileTransferHandlers(options: FileTransferOptions) {
  const { xmpp, domain, dataDir } = options;
  
  const requestUploadSlot = async (filename: string, size: number, contentType?: string): Promise<UploadSlot> => {
    console.log(`Requesting upload slot for ${filename} (${size} bytes)`);
    
    const iqId = Math.random().toString(36).substring(2);
    const requestStanza = xml("iq", { type: "get", to: domain, id: iqId },
      xml("request", { xmlns: "urn:xmpp:http:upload:0", filename, size: size.toString() })
    );
    
    try {
      const response = await xmpp.send(requestStanza);
      console.log("Upload slot response:", response.toString());
      
      const slot = response.getChild("slot", "urn:xmpp:http:upload:0");
      if (!slot) {
        throw new Error("No upload slot in response");
      }
      
      const putUrl = slot.getChildText("put");
      const getUrl = slot.getChildText("get");
      
      if (!putUrl || !getUrl) {
        throw new Error("Missing put or get URL in slot");
      }
      
      const putHeaders: Record<string, string> = {};
      const putElement = slot.getChild("put");
      if (putElement) {
        const headerElements = putElement.getChildren("header");
        for (const header of headerElements) {
          const name = header.attrs.name;
          const value = header.getText();
          if (name && value) {
            putHeaders[name] = value;
          }
        }
      }
      
      console.log(`Upload slot obtained: PUT ${putUrl}, GET ${getUrl}`);
      return { putUrl, getUrl, headers: Object.keys(putHeaders).length > 0 ? putHeaders : undefined };
    } catch (err) {
      console.error("Failed to request upload slot:", err);
      throw err;
    }
  };
  
  const uploadFileViaHTTP = async (filePath: string, putUrl: string, headers?: Record<string, string>): Promise<void> => {
    console.log(`Uploading file ${filePath} to ${putUrl}`);
    
    try {
      const fileBuffer = await fs.promises.readFile(filePath);
      const fileSize = fileBuffer.length;
      
      const fetchHeaders: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileSize.toString(),
      };
      
      if (headers) {
        Object.assign(fetchHeaders, headers);
      }
      
      const response = await fetch(putUrl, {
        method: 'PUT',
        headers: fetchHeaders,
        body: fileBuffer,
      });
      
      if (!response.ok) {
        throw new Error(`HTTP upload failed: ${response.status} ${response.statusText}`);
      }
      
      console.log(`File uploaded successfully: ${filePath}`);
    } catch (err) {
      console.error("File upload failed:", err);
      throw err;
    }
  };
  
  const sendFileWithHTTPUpload = async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
    try {
      const stats = await fs.promises.stat(filePath);
      const filename = path.basename(filePath);
      const size = stats.size;
      
      const slot = await requestUploadSlot(filename, size);
      
      await uploadFileViaHTTP(filePath, slot.putUrl, slot.headers);
      
      const messageType = isGroupChat ? "groupchat" : "chat";
      const message = xml("message", { type: messageType, to },
        text ? xml("body", {}, text) : null,
        xml("x", { xmlns: "jabber:x:oob" },
          xml("url", {}, slot.getUrl)
        )
      );
      
      await xmpp.send(message);
      console.log(`File sent successfully to ${to}: ${slot.getUrl}`);
    } catch (err) {
      console.error("Failed to send file via HTTP Upload:", err);
      throw err;
    }
  };
  
  const sendFileWithSITransfer = async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
    console.log(`Attempting SI file transfer to ${to} for ${filePath}`);
    const filename = path.basename(filePath);
    const message = `[File: ${filename}] ${text || ''}`;
    if (isGroupChat) {
      await xmpp.sendGroupchat(to, message);
    } else {
      await xmpp.send(to, message);
    }
    console.log(`SI fallback: Sent file notification for ${filename}`);
  };
  
  return {
    requestUploadSlot,
    uploadFileViaHTTP,
    sendFileWithHTTPUpload,
    sendFileWithSITransfer
  };
}
