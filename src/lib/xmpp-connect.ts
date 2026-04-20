import client from "@xmpp/client";

export interface XmppConnectConfig {
  service: string;
  domain: string;
  jid: string;
  password: string;
  resource?: string;
}

export function createXmppClient(config: XmppConnectConfig) {
  return client({
    service: config.service,
    domain: config.domain,
    username: config.jid.split("@")[0],
    password: config.password,
    resource: config.resource || config.jid.split("@")[0],
  });
}
