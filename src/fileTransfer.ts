import fs from "fs";
import path from "path";
import { xml } from "@xmpp/client";
import { Config } from "./config.js";
import { log } from "./lib/logger.js";
import { requestUploadSlot, uploadFileViaHTTP, sendFileWithHTTPUpload, type UploadSlot } from "./lib/upload-protocol.js";

const MAX_FILE_SIZE = Config.MAX_FILE_SIZE;

export interface FileTransferOptions {
  xmpp: any;
  domain: string;
  dataDir: string;
}

export function createFileTransferHandlers(options: FileTransferOptions) {
  const { xmpp, domain, dataDir } = options;

  const _requestUploadSlot = async (filename: string, size: number, contentType?: string): Promise<UploadSlot> => {
    return requestUploadSlot(xmpp, domain, filename, size, contentType);
  };

  const _uploadFileViaHTTP = async (filePath: string, putUrl: string, headers?: Record<string, string>): Promise<void> => {
    return uploadFileViaHTTP(filePath, putUrl, headers);
  };

  const _sendFileWithHTTPUpload = async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
    return sendFileWithHTTPUpload(xmpp, to, filePath, domain, text, isGroupChat, dataDir);
  };

  const sendFileWithSITransfer = async (to: string, filePath: string, text?: string, isGroupChat?: boolean): Promise<void> => {
    log.debug("SI file transfer attempted", { to });
    const filename = path.basename(filePath);
    const message = `[File: ${filename}] ${text || ''}`;
    if (isGroupChat) {
      await xmpp.sendGroupchat(to, message);
    } else {
      await xmpp.send(to, message);
    }
    log.debug("SI fallback notification sent", { filename });
  };

  return {
    requestUploadSlot: _requestUploadSlot,
    uploadFileViaHTTP: _uploadFileViaHTTP,
    sendFileWithHTTPUpload: _sendFileWithHTTPUpload,
    sendFileWithSITransfer
  };
}
