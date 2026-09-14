# XMPP Audit — Plugin Implementation Status

Audit of XMPP specifications against the OpenClaw XMPP plugin codebase.
Generated from https://xmpp.org/extensions/ and source code analysis.
Date: 2026-09-14 (targeted revision; originally 2026-06-23)
Plugin version: 2.15.2 (OpenClaw 2026.9.4)

> This revision corrects the status of features shipped after the original
> audit (notably XEP-0292 vCard4 and PEP usage) and adds a compliance /
> prioritization section. It is a targeted update, not a full re-scan.

## IETF RFCs

| RFC | Name | Status |
|-----|------|--------|
| RFC 6120 | XMPP Core | Supported (via @xmpp/client) |
| RFC 6121 | XMPP IM | Supported (via @xmpp/client) + plugin presence/status (show/status/priority, auto-busy) |
| RFC 7395 | XMPP over WebSockets | Supported (via @xmpp/client) |
| RFC 7590 | Use of TLS in XMPP | Supported (TLS enforced) |
| RFC 7622 | XMPP Address Format | Supported (JID parsing/validation) |

## XMPP Extension Protocols (XEPs)

XEPs with XSF status Obsolete, Rejected, Deprecated, or Retracted are excluded from this list.

### Legend
| Label | Meaning |
|-------|---------|
| **Supported** | Actively implemented in plugin source code |
| **Partial** | Partially implemented or limited support |
| **Detected** | Stanzas parsed/detected but no active handling |
| Not Supported | No implementation found in codebase |

| XEP | Name | XSF Status | Plugin Status |
|-----|------|------------|---------------|
| XEP-0001 | XMPP Extension Protocols | Active | Not Supported |
| XEP-0002 | Special Interest Groups (SIGs) | Active | Not Supported |
| XEP-0004 | Data Forms | Final | Supported |
| XEP-0009 | Jabber-RPC | Final | Not Supported |
| XEP-0012 | Last Activity | Final | Not Supported |
| XEP-0019 | Streamlining the SIGs | Active | Not Supported |
| XEP-0030 | Service Discovery | Final | Supported |
| XEP-0031 | A Framework For Securing Jabber Conversations | Deferred | Not Supported |
| XEP-0033 | Extended Stanza Addressing | Stable | Not Supported |
| XEP-0039 | Statistics Gathering | Deferred | Not Supported |
| XEP-0044 | Full Namespace Support for XML Streams | Deferred | Not Supported |
| XEP-0045 | Multi-User Chat | Stable | Supported |
| XEP-0047 | In-Band Bytestreams | Final | Supported |
| XEP-0049 | Private XML Storage | Active | Not Supported |
| XEP-0050 | Ad-Hoc Commands | Stable | Not Supported |
| XEP-0053 | XMPP Registrar Function | Active | Not Supported |
| XEP-0054 | vcard-temp | Active | Supported |
| XEP-0055 | Jabber Search | Active | Not Supported |
| XEP-0056 | Business Data Interchange | Deferred | Not Supported |
| XEP-0058 | Multi-User Text Editing | Deferred | Not Supported |
| XEP-0059 | Result Set Management | Stable | Not Supported |
| XEP-0060 | Publish-Subscribe | Stable | Supported |
| XEP-0061 | Shared Notes | Deferred | Not Supported |
| XEP-0062 | Packet Filtering | Deferred | Not Supported |
| XEP-0063 | Basic Filtering Operations | Deferred | Not Supported |
| XEP-0064 | XPath Filtering | Deferred | Not Supported |
| XEP-0065 | SOCKS5 Bytestreams | Stable | Supported |
| XEP-0066 | Out of Band Data | Stable | Supported |
| XEP-0067 | Stock Data Transmission | Deferred | Not Supported |
| XEP-0068 | Field Standardization for Data Forms | Active | Not Supported |
| XEP-0069 | Compliance SIG | Deferred | Not Supported |
| XEP-0070 | Verifying HTTP Requests via XMPP | Stable | Not Supported |
| XEP-0072 | SOAP Over XMPP | Stable | Not Supported |
| XEP-0075 | Jabber Object Access Protocol (JOAP) | Deferred | Not Supported |
| XEP-0076 | Malicious Stanzas | Active | Not Supported |
| XEP-0077 | In-Band Registration | Final | Not Supported |
| XEP-0079 | Advanced Message Processing | Stable | Not Supported |
| XEP-0080 | User Location | Stable | Not Supported |
| XEP-0082 | XMPP Date and Time Profiles | Active | Not Supported |
| XEP-0083 | Nested Roster Groups | Active | Not Supported |
| XEP-0084 | User Avatar | Stable | Supported |
| XEP-0085 | Chat State Notifications | Final | Not Supported |
| XEP-0088 | Client Webtabs | Deferred | Not Supported |
| XEP-0089 | Generic Alerts | Deferred | Not Supported |
| XEP-0092 | Software Version | Stable | Not Supported |
| XEP-0097 | iCal Envelope | Deferred | Not Supported |
| XEP-0098 | Enhanced Private XML Storage | Deferred | Not Supported |
| XEP-0099 | IQ Query Action Protocol | Deferred | Not Supported |
| XEP-0100 | Gateway Interaction | Active | Not Supported |
| XEP-0101 | HTTP Authentication using Jabber Tickets | Deferred | Not Supported |
| XEP-0102 | Security Extensions | Deferred | Not Supported |
| XEP-0103 | URL Address Information | Deferred | Not Supported |
| XEP-0104 | HTTP Scheme for URL Data | Deferred | Not Supported |
| XEP-0105 | Tree Transfer Stream Initiation Profile | Deferred | Not Supported |
| XEP-0106 | JID Escaping | Stable | Not Supported |
| XEP-0107 | User Mood | Stable | Not Supported |
| XEP-0108 | User Activity | Stable | Not Supported |
| XEP-0109 | Out-of-Office Messages | Deferred | Not Supported |
| XEP-0110 | Generic Maps | Deferred | Not Supported |
| XEP-0113 | Simple Whiteboarding | Deferred | Supported |
| XEP-0114 | Jabber Component Protocol | Active | Not Supported |
| XEP-0115 | Entity Capabilities | Stable | Supported |
| XEP-0116 | Encrypted Session Negotiation | Deferred | Not Supported |
| XEP-0118 | User Tune | Stable | Not Supported |
| XEP-0122 | Data Forms Validation | Stable | Not Supported |
| XEP-0124 | Bidirectional-streams Over Synchronous HTTP (BOSH) | Stable | Not Supported |
| XEP-0127 | Common Alerting Protocol (CAP) Over XMPP | Active | Not Supported |
| XEP-0128 | Service Discovery Extensions | Active | Not Supported |
| XEP-0129 | WebDAV File Transfers | Deferred | Not Supported |
| XEP-0131 | Stanza Headers and Internet Metadata | Stable | Not Supported |
| XEP-0132 | Presence Obtained via Kinesthetic Excitation (POKE) | Active | Not Supported |
| XEP-0133 | Service Administration | Active | Not Supported |
| XEP-0134 | XMPP Design Guidelines | Active | Not Supported |
| XEP-0135 | File Sharing | Deferred | Not Supported |
| XEP-0141 | Data Forms Layout | Stable | Not Supported |
| XEP-0142 | Workgroup Queues | Deferred | Not Supported |
| XEP-0143 | Guidelines for Authors of XMPP Extension Protocols | Active | Not Supported |
| XEP-0144 | Roster Item Exchange | Stable | Not Supported |
| XEP-0145 | Annotations | Active | Not Supported |
| XEP-0147 | XMPP URI Scheme Query Components | Active | Not Supported |
| XEP-0148 | Instant Messaging Intelligence Quotient (IM IQ) | Active | Not Supported |
| XEP-0149 | Time Periods | Active | Not Supported |
| XEP-0150 | Use of Entity Tags in XMPP Extensions | Deferred | Not Supported |
| XEP-0151 | Virtual Presence | Deferred | Not Supported |
| XEP-0152 | Reachability Addresses | Stable | Not Supported |
| XEP-0153 | vCard-Based Avatars | Active | Not Supported |
| XEP-0154 | User Profile | Deferred | Not Supported |
| XEP-0155 | Stanza Session Negotiation | Stable | Not Supported |
| XEP-0156 | Discovering Alternative XMPP Connection Methods | Stable | Not Supported |
| XEP-0157 | Contact Addresses for XMPP Services | Active | Not Supported |
| XEP-0158 | CAPTCHA Forms | Stable | Not Supported |
| XEP-0159 | Spim-Blocking Control | Deferred | Not Supported |
| XEP-0160 | Best Practices for Handling Offline Messages | Active | Not Supported |
| XEP-0161 | Abuse Reporting | Deferred | Not Supported |
| XEP-0162 | Best Practices for Roster and Subscription Management | Deferred | Not Supported |
| XEP-0163 | Personal Eventing Protocol | Stable | Partial ¹ |
| XEP-0164 | vCard Filtering | Deferred | Not Supported |
| XEP-0165 | Best Practices to Discourage JID Mimicking | Deferred | Not Supported |
| XEP-0166 | Jingle | Stable | Not Supported |
| XEP-0167 | Jingle RTP Sessions | Stable | Not Supported |
| XEP-0168 | Resource Application Priority | Deferred | Not Supported |
| XEP-0169 | Twas The Night Before Christmas (Jabber Version) | Active | Not Supported |
| XEP-0170 | Recommended Order of Stream Feature Negotiation | Active | Not Supported |
| XEP-0171 | Language Translation | Stable | Not Supported |
| XEP-0172 | User Nickname | Stable | Not Supported |
| XEP-0173 | Pubsub Subscription Storage | Deferred | Not Supported |
| XEP-0174 | Serverless Messaging | Final | Not Supported |
| XEP-0175 | Best Practices for Use of SASL ANONYMOUS | Active | Not Supported |
| XEP-0176 | Jingle ICE-UDP Transport Method | Stable | Not Supported |
| XEP-0177 | Jingle Raw UDP Transport Method | Stable | Not Supported |
| XEP-0178 | Best Practices for Use of SASL EXTERNAL with Certificates | Active | Not Supported |
| XEP-0179 | Jingle IAX Transport Method | Deferred | Not Supported |
| XEP-0181 | Jingle DTMF | Deferred | Not Supported |
| XEP-0182 | Application-Specific Error Conditions | Active | Not Supported |
| XEP-0183 | Jingle Telepathy Transport | Active | Not Supported |
| XEP-0184 | Message Delivery Receipts | Stable | Not Supported |
| XEP-0185 | Dialback Key Generation and Validation | Active | Not Supported |
| XEP-0186 | Invisible Command | Deferred | Not Supported |
| XEP-0187 | Offline Encrypted Sessions | Deferred | Not Supported |
| XEP-0188 | Cryptographic Design of Encrypted Sessions | Deferred | Not Supported |
| XEP-0189 | Public Key Publishing | Deferred | Not Supported |
| XEP-0191 | Blocking Command | Stable | Not Supported |
| XEP-0194 | User Chatting | Deferred | Not Supported |
| XEP-0195 | User Browsing | Deferred | Not Supported |
| XEP-0196 | User Gaming | Deferred | Not Supported |
| XEP-0197 | User Viewing | Deferred | Not Supported |
| XEP-0198 | Stream Management | Stable | Supported |
| XEP-0199 | XMPP Ping | Final | Supported |
| XEP-0200 | Stanza Encryption | Deferred | Not Supported |
| XEP-0201 | Best Practices for Message Threads | Active | Not Supported |
| XEP-0202 | Entity Time | Final | Not Supported |
| XEP-0203 | Delayed Delivery | Final | Not Supported |
| XEP-0204 | Collaborative Data Objects | Deferred | Not Supported |
| XEP-0205 | Best Practices to Discourage Denial of Service Attacks | Active | Not Supported |
| XEP-0206 | XMPP Over BOSH | Stable | Not Supported |
| XEP-0207 | XMPP Eventing via Pubsub | Active | Not Supported |
| XEP-0209 | Metacontacts | Deferred | Not Supported |
| XEP-0210 | Requirements for Encrypted Sessions | Deferred | Not Supported |
| XEP-0214 | File Repository and Sharing | Deferred | Not Supported |
| XEP-0215 | External Service Discovery | Stable | Not Supported |
| XEP-0217 | Simplified Encrypted Session Negotiation | Deferred | Not Supported |
| XEP-0218 | Bootstrapping Implementation of Encrypted Sessions | Deferred | Not Supported |
| XEP-0220 | Server Dialback | Stable | Not Supported |
| XEP-0221 | Data Forms Media Element | Stable | Not Supported |
| XEP-0222 | Persistent Storage of Public Data via PubSub | Active | Not Supported |
| XEP-0223 | Persistent Storage of Private Data via PubSub | Active | Not Supported |
| XEP-0224 | Attention | Stable | Not Supported |
| XEP-0225 | Component Connections | Deferred | Not Supported |
| XEP-0226 | Message Stanza Profiles | Deferred | Not Supported |
| XEP-0227 | Portable Import/Export Format for XMPP-IM Servers | Stable | Not Supported |
| XEP-0228 | Requirements for Shared Editing | Deferred | Not Supported |
| XEP-0230 | Service Discovery Notifications | Deferred | Not Supported |
| XEP-0231 | Bits of Binary | Stable | Detected |
| XEP-0232 | Software Information | Deferred | Not Supported |
| XEP-0233 | XMPP Server Registration for use with Kerberos V5 | Stable | Not Supported |
| XEP-0234 | Jingle File Transfer | Deferred | Not Supported |
| XEP-0235 | OAuth Over XMPP | Deferred | Not Supported |
| XEP-0238 | XMPP Protocol Flows for Inter-Domain Federation | Deferred | Not Supported |
| XEP-0239 | Binary XMPP | Active | Not Supported |
| XEP-0240 | Auto-Discovery of JabberIDs | Deferred | Not Supported |
| XEP-0241 | Encryption of Archived Messages | Deferred | Not Supported |
| XEP-0244 | IO Data | Deferred | Not Supported |
| XEP-0245 | The /me Command | Active | Not Supported |
| XEP-0246 | End-to-End XML Streams | Deferred | Not Supported |
| XEP-0247 | Jingle XML Streams | Deferred | Not Supported |
| XEP-0248 | PubSub Collection Nodes | Deferred | Not Supported |
| XEP-0249 | Direct MUC Invitations | Stable | Supported |
| XEP-0250 | C2C Authentication Using TLS | Deferred | Not Supported |
| XEP-0251 | Jingle Session Transfer | Deferred | Not Supported |
| XEP-0252 | BOSH Script Syntax | Deferred | Not Supported |
| XEP-0253 | PubSub Chaining | Deferred | Not Supported |
| XEP-0254 | PubSub Queueing | Deferred | Not Supported |
| XEP-0255 | Location Query | Deferred | Not Supported |
| XEP-0257 | Client Certificate Management for SASL EXTERNAL | Deferred | Not Supported |
| XEP-0258 | Security Labels in XMPP | Stable | Not Supported |
| XEP-0259 | Message Mine-ing | Deferred | Not Supported |
| XEP-0260 | Jingle SOCKS5 Bytestreams Transport Method | Stable | Not Supported |
| XEP-0261 | Jingle In-Band Bytestreams Transport Method | Stable | Not Supported |
| XEP-0262 | Use of ZRTP in Jingle RTP Sessions | Stable | Not Supported |
| XEP-0263 | ECO-XMPP | Active | Not Supported |
| XEP-0264 | Jingle Content Thumbnails | Experimental | Not Supported |
| XEP-0265 | Out-of-Band Stream Data | Deferred | Not Supported |
| XEP-0266 | Codecs for Jingle Audio | Stable | Not Supported |
| XEP-0267 | Server Buddies | Deferred | Not Supported |
| XEP-0268 | Incident Handling | Deferred | Not Supported |
| XEP-0269 | Jingle Early Media | Deferred | Not Supported |
| XEP-0271 | XMPP Nodes | Deferred | Not Supported |
| XEP-0272 | Multiparty Jingle (Muji) | Experimental | Not Supported |
| XEP-0273 | Stanza Interception and Filtering Technology (SIFT) | Deferred | Not Supported |
| XEP-0274 | Design Considerations for Digital Signatures in XMPP | Deferred | Not Supported |
| XEP-0275 | Entity Reputation | Deferred | Not Supported |
| XEP-0276 | Presence Decloaking | Deferred | Not Supported |
| XEP-0277 | Microblogging over XMPP | Deferred | Not Supported |
| XEP-0278 | Jingle Relay Nodes | Deferred | Not Supported |
| XEP-0279 | Server IP Check | Deferred | Not Supported |
| XEP-0280 | Message Carbons | Stable | Not Supported |
| XEP-0282 | DMUC2: Distributed MUC | Deferred | Not Supported |
| XEP-0283 | Moved | Experimental | Not Supported |
| XEP-0284 | Shared XML Editing | Experimental | Not Supported |
| XEP-0285 | Encapsulating Digital Signatures in XMPP | Deferred | Not Supported |
| XEP-0286 | Mobile Considerations on LTE Networks | Active | Not Supported |
| XEP-0287 | Spim Markers and Reports | Deferred | Not Supported |
| XEP-0288 | Bidirectional Server-to-Server Connections | Stable | Not Supported |
| XEP-0289 | Federated MUC for Constrained Environments | Deferred | Not Supported |
| XEP-0290 | Encapsulated Digital Signatures in XMPP | Deferred | Not Supported |
| XEP-0291 | Service Delegation | Deferred | Not Supported |
| XEP-0292 | vCard4 Over XMPP | Experimental | Supported |
| XEP-0293 | Jingle RTP Feedback Negotiation | Stable | Not Supported |
| XEP-0294 | Jingle RTP Header Extensions Negotiation | Stable | Not Supported |
| XEP-0295 | JSON Encodings for XMPP | Active | Not Supported |
| XEP-0296 | Best Practices for Resource Locking | Deferred | Not Supported |
| XEP-0297 | Stanza Forwarding | Stable | Not Supported |
| XEP-0298 | Delivering Conference Information to Jingle Participants (Coin) | Deferred | Not Supported |
| XEP-0299 | Codecs for Jingle Video | Deferred | Not Supported |
| XEP-0300 | Use of Cryptographic Hash Functions in XMPP | Stable | Not Supported |
| XEP-0301 | In-Band Real Time Text | Stable | Not Supported |
| XEP-0303 | Commenting | Deferred | Not Supported |
| XEP-0304 | Whitespace Keepalive Negotiation | Deferred | Not Supported ² |
| XEP-0305 | XMPP Quickstart | Deferred | Not Supported |
| XEP-0306 | Extensible Status Conditions for Multi-User Chat | Deferred | Not Supported |
| XEP-0307 | Unique Room Names for Multi-User Chat | Deferred | Not Supported |
| XEP-0308 | Last Message Correction | Stable | Not Supported |
| XEP-0309 | Service Directories | Deferred | Not Supported |
| XEP-0310 | Presence State Annotations | Deferred | Not Supported |
| XEP-0311 | MUC Fast Reconnect | Deferred | Not Supported |
| XEP-0312 | PubSub Since | Deferred | Not Supported |
| XEP-0313 | Message Archive Management | Stable | Not Supported |
| XEP-0314 | Security Labels in PubSub | Deferred | Not Supported |
| XEP-0315 | Data Forms XML Element | Deferred | Not Supported |
| XEP-0316 | MUC Eventing Protocol | Deferred | Not Supported |
| XEP-0317 | Hats | Experimental | Not Supported |
| XEP-0318 | Best Practices for Client Initiated Presence Probes | Deferred | Not Supported |
| XEP-0319 | Last User Interaction in Presence | Stable | Not Supported |
| XEP-0320 | Use of DTLS-SRTP in Jingle Sessions | Stable | Not Supported |
| XEP-0321 | Remote Roster Management | Deferred | Not Supported |
| XEP-0322 | Efficient XML Interchange (EXI) Format | Deferred | Not Supported |
| XEP-0327 | Rayo | Deferred | Not Supported |
| XEP-0328 | JID Preparation and Validation Service | Deferred | Not Supported |
| XEP-0329 | File Information Sharing | Deferred | Not Supported |
| XEP-0330 | Pubsub Subscription | Deferred | Not Supported |
| XEP-0331 | Data Forms - Color Field Types | Deferred | Not Supported |
| XEP-0332 | HTTP over XMPP transport | Deferred | Not Supported |
| XEP-0333 | Displayed Markers | Stable | Not Supported |
| XEP-0334 | Message Processing Hints | Stable | Not Supported |
| XEP-0335 | JSON Containers | Deferred | Not Supported |
| XEP-0336 | Data Forms - Dynamic Forms | Deferred | Not Supported |
| XEP-0337 | Event Logging over XMPP | Deferred | Not Supported |
| XEP-0338 | Jingle Grouping Framework | Stable | Not Supported |
| XEP-0339 | Source-Specific Media Attributes in Jingle | Stable | Not Supported |
| XEP-0340 | COnferences with LIghtweight BRIdging (COLIBRI) | Deferred | Not Supported |
| XEP-0341 | Rayo CPA | Deferred | Not Supported |
| XEP-0342 | Rayo Fax | Deferred | Not Supported |
| XEP-0343 | Signaling WebRTC datachannels in Jingle | Deferred | Not Supported |
| XEP-0344 | Impact of TLS and DNSSEC on Dialback | Deferred | Not Supported |
| XEP-0345 | Form of Membership Applications | Active | Not Supported |
| XEP-0346 | Form Discovery and Publishing | Deferred | Not Supported |
| XEP-0347 | Internet of Things - Discovery | Deferred | Not Supported |
| XEP-0348 | Signing Forms | Deferred | Not Supported |
| XEP-0349 | Rayo Clustering | Deferred | Not Supported |
| XEP-0350 | Data Forms Geolocation Element | Deferred | Not Supported |
| XEP-0351 | Recipient Server Side Notifications Filtering | Deferred | Not Supported |
| XEP-0352 | Client State Indication | Stable | Not Supported |
| XEP-0353 | Jingle Message Initiation | Experimental | Not Supported |
| XEP-0354 | Customizable Message Routing | Deferred | Not Supported |
| XEP-0355 | Namespace Delegation | Experimental | Not Supported |
| XEP-0356 | Privileged Entity | Experimental | Not Supported |
| XEP-0357 | Push Notifications | Deferred | Not Supported |
| XEP-0358 | Publishing Available Jingle Sessions | Deferred | Not Supported |
| XEP-0359 | Unique and Stable Stanza IDs | Experimental | Not Supported |
| XEP-0361 | Zero Handshake Server to Server Protocol | Deferred | Not Supported |
| XEP-0362 | Raft over XMPP | Deferred | Not Supported |
| XEP-0363 | HTTP File Upload | Stable | Supported |
| XEP-0364 | Current Off-the-Record Messaging Usage | Deferred | Not Supported |
| XEP-0365 | Server to Server communication over STANAG 5066 ARQ | Experimental | Not Supported |
| XEP-0366 | Entity Versioning | Deferred | Not Supported |
| XEP-0367 | Message Attaching | Deferred | Not Supported |
| XEP-0368 | SRV records for XMPP over TLS | Stable | Not Supported |
| XEP-0369 | Mediated Information eXchange (MIX) | Experimental | Not Supported |
| XEP-0370 | Jingle HTTP Transport Method | Deferred | Not Supported |
| XEP-0371 | Jingle ICE Transport Method | Deferred | Not Supported |
| XEP-0372 | References | Experimental | Not Supported |
| XEP-0373 | OpenPGP for XMPP | Experimental | Not Supported |
| XEP-0374 | OpenPGP for XMPP Instant Messaging | Deferred | Not Supported |
| XEP-0376 | Pubsub Account Management | Deferred | Not Supported |
| XEP-0377 | Blocking Command Reports | Proposed | Not Supported |
| XEP-0378 | OTR Discovery | Deferred | Not Supported |
| XEP-0379 | Pre-Authenticated Roster Subscription | Proposed | Not Supported |
| XEP-0380 | Explicit Message Encryption | Deferred | Not Supported |
| XEP-0381 | Internet of Things Special Interest Group (IoT SIG) | Active | Not Supported |
| XEP-0382 | Spoiler messages | Deferred | Not Supported |
| XEP-0383 | Burner JIDs | Experimental | Not Supported |
| XEP-0384 | OMEMO Encryption | Experimental | Not Supported |
| XEP-0385 | Stateless Inline Media Sharing (SIMS) | Deferred | Detected |
| XEP-0386 | Bind 2 | Stable | Not Supported |
| XEP-0388 | Extensible SASL Profile | Stable | Not Supported |
| XEP-0389 | Extensible In-Band Registration | Experimental | Not Supported |
| XEP-0390 | Entity Capabilities 2.0 | Deferred | Not Supported |
| XEP-0391 | Jingle Encrypted Transports | Deferred | Not Supported |
| XEP-0392 | Consistent Color Generation | Stable | Not Supported |
| XEP-0393 | Message Styling | Stable | Not Supported |
| XEP-0394 | Message Markup | Experimental | Not Supported |
| XEP-0395 | Atomically Compare-And-Publish PubSub Items | Deferred | Not Supported |
| XEP-0396 | Jingle Encrypted Transports - OMEMO | Deferred | Not Supported |
| XEP-0397 | Instant Stream Resumption | Deferred | Not Supported |
| XEP-0398 | User Avatar to vCard-Based Avatars Conversion | Stable | Not Supported |
| XEP-0399 | Client Key Support | Deferred | Not Supported |
| XEP-0400 | Multi-Factor Authentication with TOTP | Deferred | Not Supported |
| XEP-0401 | Ad-hoc Account Invitation Generation | Experimental | Not Supported |
| XEP-0402 | PEP Native Bookmarks | Stable | Not Supported |
| XEP-0403 | Mediated Information eXchange (MIX): Presence Support. | Deferred | Not Supported |
| XEP-0404 | Mediated Information eXchange (MIX): JID Hidden Channels. | Deferred | Not Supported |
| XEP-0405 | Mediated Information eXchange (MIX): Participant Server Requirements | Experimental | Not Supported |
| XEP-0406 | Mediated Information eXchange (MIX): MIX Administration | Deferred | Not Supported |
| XEP-0407 | Mediated Information eXchange (MIX): Miscellaneous Capabilities | Deferred | Not Supported |
| XEP-0408 | Mediated Information eXchange (MIX): Co-existence with MUC | Deferred | Not Supported |
| XEP-0409 | IM Routing-NG | Deferred | Not Supported |
| XEP-0410 | MUC Self-Ping (SchrÃ¶dinger's Chat) | Stable | Not Supported |
| XEP-0413 | Order-By | Experimental | Not Supported |
| XEP-0414 | Cryptographic Hash Function Recommendations for XMPP | Deferred | Not Supported |
| XEP-0415 | XMPP Over RELOAD (XOR) | Deferred | Not Supported |
| XEP-0416 | E2E Authentication in XMPP | Deferred | Not Supported |
| XEP-0417 | E2E Authentication in XMPP: Certificate Issuance and Revocation | Deferred | Not Supported |
| XEP-0418 | DNS Queries over XMPP (DoX) | Deferred | Not Supported |
| XEP-0419 | Improving Baseline Security in XMPP | Active | Not Supported |
| XEP-0420 | Stanza Content Encryption | Experimental | Not Supported |
| XEP-0421 | Occupant identifiers for semi-anonymous MUCs | Stable | Not Supported |
| XEP-0422 | Message Fastening | Deferred | Not Supported |
| XEP-0424 | Message Retraction | Proposed | Not Supported |
| XEP-0425 | Moderated Message Retraction | Experimental | Not Supported |
| XEP-0426 | Character counting in message bodies | Experimental | Not Supported |
| XEP-0427 | MAM Fastening Collation | Deferred | Not Supported |
| XEP-0428 | Fallback Indication | Experimental | Not Supported |
| XEP-0429 | Special Interests Group End to End Encryption | Active | Not Supported |
| XEP-0430 | Inbox | Deferred | Not Supported |
| XEP-0431 | Full Text Search in MAM | Deferred | Not Supported |
| XEP-0432 | Simple JSON Messaging | Deferred | Not Supported |
| XEP-0433 | Extended Channel Search | Deferred | Not Supported |
| XEP-0434 | Trust Messages (TM) | Experimental | Not Supported |
| XEP-0435 | Reminders | Deferred | Not Supported |
| XEP-0436 | MUC presence versioning | Deferred | Not Supported |
| XEP-0437 | Room Activity Indicators | Deferred | Not Supported |
| XEP-0438 | Best practices for password hashing and storage | Experimental | Not Supported |
| XEP-0439 | Quick Response | Deferred | Not Supported |
| XEP-0440 | SASL Channel-Binding Type Capability | Stable | Not Supported |
| XEP-0441 | Message Archive Management Preferences | Experimental | Not Supported |
| XEP-0442 | Pubsub Message Archive Management | Experimental | Not Supported |
| XEP-0444 | Message Reactions | Experimental | Not Supported |
| XEP-0445 | Pre-Authenticated In-Band Registration | Proposed | Not Supported |
| XEP-0446 | File metadata element | Experimental | Not Supported |
| XEP-0447 | Stateless file sharing | Experimental | Detected |
| XEP-0448 | Encryption for stateless file sharing | Experimental | Not Supported |
| XEP-0449 | Stickers | Experimental | Not Supported |
| XEP-0450 | Automatic Trust Management (ATM) | Experimental | Not Supported |
| XEP-0451 | Stanza Multiplexing | Experimental | Not Supported |
| XEP-0452 | MUC Mention Notifications | Experimental | Not Supported |
| XEP-0453 | DOAP usage in XMPP | Experimental | Not Supported |
| XEP-0454 | OMEMO Media sharing | Experimental | Not Supported |
| XEP-0455 | Service Outage Status | Experimental | Not Supported |
| XEP-0456 | Content Rating Labels | Experimental | Not Supported |
| XEP-0457 | Message Fancying | Active | Not Supported |
| XEP-0458 | Community Code of Conduct | Active | Not Supported |
| XEP-0460 | Pubsub Caching Hints | Experimental | Not Supported |
| XEP-0461 | Message Replies | Experimental | Not Supported |
| XEP-0462 | PubSub Type Filtering | Experimental | Not Supported |
| XEP-0463 | MUC Affiliations Versioning | Experimental | Not Supported |
| XEP-0464 | Cookies | Active | Not Supported |
| XEP-0465 | Pubsub Public Subscriptions | Experimental | Not Supported |
| XEP-0466 | Ephemeral Messages | Experimental | Not Supported |
| XEP-0467 | XMPP over QUIC | Experimental | Not Supported |
| XEP-0468 | WebSocket S2S | Experimental | Not Supported |
| XEP-0469 | Bookmark Pinning | Experimental | Not Supported |
| XEP-0470 | Pubsub Attachments | Experimental | Not Supported |
| XEP-0471 | Calendar Events | Experimental | Not Supported |
| XEP-0472 | Pubsub Social Feed | Experimental | Not Supported |
| XEP-0473 | OpenPGP for XMPP Pubsub | Experimental | Not Supported |
| XEP-0474 | SASL SCRAM Downgrade Protection | Experimental | Not Supported |
| XEP-0475 | Pubsub Signing | Experimental | Not Supported |
| XEP-0476 | Pubsub Signing: OpenPGP Profile | Experimental | Not Supported |
| XEP-0477 | Pubsub Targeted Encryption | Experimental | Not Supported |
| XEP-0478 | Stream Limits Advertisement | Experimental | Not Supported |
| XEP-0479 | XMPP Compliance Suites 2023 | Experimental | Not Supported |
| XEP-0480 | SASL Upgrade Tasks | Experimental | Not Supported |
| XEP-0481 | Content Types in Messages | Experimental | Not Supported |
| XEP-0482 | Call Invites | Experimental | Not Supported |
| XEP-0483 | HTTP Online Meetings | Experimental | Not Supported |
| XEP-0484 | Fast Authentication Streamlining Tokens | Proposed | Not Supported |
| XEP-0485 | PubSub Server Information | Stable | Not Supported |
| XEP-0486 | MUC Avatars | Experimental | Not Supported |
| XEP-0487 | Host Meta 2 - One Method To Rule Them All | Experimental | Not Supported |
| XEP-0488 | MUC Token Invite | Experimental | Not Supported |
| XEP-0489 | Reporting Account Affiliations | Experimental | Not Supported |
| XEP-0490 | Message Displayed Synchronization | Stable | Not Supported |
| XEP-0491 | WebXDC | Experimental | Not Supported |
| XEP-0492 | Chat notification settings | Experimental | Not Supported |
| XEP-0493 | OAuth Client Login | Experimental | Not Supported |
| XEP-0494 | Client Access Management | Experimental | Not Supported |
| XEP-0495 | Happy Eyeballs | Experimental | Not Supported |
| XEP-0496 | Pubsub Node Relationships | Experimental | Not Supported |
| XEP-0497 | Pubsub Extended Subscriptions | Experimental | Not Supported |
| XEP-0498 | Pubsub File Sharing | Experimental | Not Supported |
| XEP-0499 | Pubsub Extended Discovery | Experimental | Not Supported |
| XEP-0500 | MUC Slow Mode | Experimental | Not Supported |
| XEP-0501 | Pubsub Stories | Experimental | Not Supported |
| XEP-0502 | MUC Activity Indicator | Experimental | Not Supported |
| XEP-0503 | Server-side spaces | Experimental | Not Supported |
| XEP-0504 | Data Policy | Experimental | Not Supported |
| XEP-0505 | Data Forms File Input Element | Experimental | Not Supported |
| XEP-0506 | No-reply JIDs | Experimental | Not Supported |
| XEP-0507 | Jingle Content Category | Experimental | Not Supported |
| XEP-0508 | Forums | Experimental | Not Supported |
| XEP-0509 | Initial Authentication Pipelining | Experimental | Not Supported |
| XEP-0510 | End-to-End Encrypted Contacts Metadata | Experimental | Not Supported |
| XEP-0511 | Link Metadata | Experimental | Not Supported |
| XEP-0512 | XMPP as Interpretive Dance | Active | Not Supported |
| XEP-0513 | Explicit Mentions | Experimental | Not Supported |
| XEP-0514 | Emoji Markup | Experimental | Not Supported |

## Summary

| Category | Count |
|----------|-------|
| Supported | 16 |
| Partial | 1 |
| Detected | 3 |
| Not Supported | 396 |
| **Total XEPs listed** | 416 |

### Supported Breakdown

| XEP | Feature | Implementation Details |
|-----|---------|----------------------|
| XEP-0004 | Data Forms | startXMPP.ts (SI negot, MUC config) |
| XEP-0030 | Service Discovery | startXMPP.ts (disco#info responder) |
| XEP-0045 | Multi-User Chat | startXMPP.ts (join/leave, invites, owner config) |
| XEP-0047 | In-Band Bytestreams | startXMPP.ts (IBB open/data/close sessions) |
| XEP-0054 | vcard-temp | startXMPP.ts, vcard.ts, vcard-server.ts, lib/vcard-ops.ts |
| XEP-0060 | Publish-Subscribe | vcard-server.ts, lib/vcard-ops.ts (PEP avatar/vCard4 pubsub) |
| XEP-0065 | SOCKS5 Bytestreams | startXMPP.ts (streamhost, SOCKS5 activate) |
| XEP-0066 | Out of Band Data | startXMPP.ts, upload-protocol.ts (OOB detection & send) |
| XEP-0084 | User Avatar | vcard-server.ts, lib/vcard-ops.ts (PEP metadata+data nodes) |
| XEP-0113 | Simple Whiteboarding | whiteboard.ts, startXMPP.ts (SWB path/move/delete) |
| XEP-0115 | Entity Capabilities | config.ts, startXMPP.ts (presence caps hash) |
| XEP-0198 | Stream Management | startXMPP.ts (@xmpp/stream-management) |
| XEP-0199 | XMPP Ping | startXMPP.ts (iq ping handler) |
| XEP-0249 | Direct MUC Invitations | startXMPP.ts (jabber:x:conference auto-accept) |
| XEP-0292 | vCard4 Over XMPP | lib/vcard4-protocol.ts, vcard-server.ts (PEP `urn:xmpp:vcard4`), lib/vcard-ops.ts |
| XEP-0363 | HTTP File Upload | lib/upload-protocol.ts, slash-commands.ts (full upload flow) |

### Partial Breakdown

| XEP | Feature | Why partial |
|-----|---------|-------------|
| XEP-0163 | Personal Eventing Protocol | The plugin publishes to PEP nodes (`urn:xmpp:avatar:metadata`/`:data`, `urn:xmpp:vcard4`) and advertises `+notify` caps, but does not implement the full PEP feature set (subscriptions/config, item retraction semantics beyond avatar). |

### Detected Breakdown

| XEP | Feature | What is parsed |
|-----|---------|----------------|
| XEP-0231 | Bits of Binary | `<data xmlns="urn:xmpp:bob">` in inbound shared files (`startXMPP.ts`). |
| XEP-0385 | Stateless Inline Media Sharing (SIMS) | `<media-sharing xmlns="urn:xmpp:sims:1">` (parsed, not generated). |
| XEP-0447 | Stateless file sharing | `<file-sharing xmlns="urn:xmpp:sfs:0">` (parsed, not generated). |

### Footnotes

1. **XEP-0163** — counted as Partial (PEP is used for avatar/vCard4 publishing); see Partial Breakdown.
2. **XEP-0304** — the plugin sends XML **whitespace keepalive** (`startXMPP.ts`, `WHITESPACE_KEEPALIVE_MS`) but does not implement the XEP's disco-based negotiation, so it is not counted as supported.

---

## Compliance & prioritization

This is a **curated recommendation**, not an authoritative mapping to the XEP
Compliance Suites (e.g. XEP-0479, 2023). It is meant to point at the next
high-value XEPs for this bot.

### Compliance-relevant capabilities already present

- **Core:** RFC 6120 (TLS via RFC 7590), RFC 7622 (JID format), XEP-0030
  (disco#info), XEP-0115 (entity caps), XEP-0198 (stream management),
  XEP-0199 (ping).
- **IM:** RFC 6121 messaging + presence/status (built-in shows, custom status,
  persistence, auto-busy while thinking/tooling).
- **Advanced IM / MUC:** XEP-0045 (MUC), XEP-0249 (direct invites),
  XEP-0113 (whiteboarding).
- **File transfer:** XEP-0096/XEP-0065/XEP-0047 (SI/SOCKS5/IBB), XEP-0363
  (HTTP Upload), XEP-0066 (OOB), plus plugin SFTP (non-XMPP).
- **Profiles:** XEP-0054 (vcard-temp), XEP-0084 (avatar), XEP-0292 (vCard4).

### Recommended next XEPs (priority order)

| Priority | XEP | Name | Why |
|----------|-----|------|-----|
| High | XEP-0410 | MUC Self-Ping (Schrödinger's Chat) | Detect/recover ghost MUC sessions; complements the existing rejoin logic and prevents silent groupchat loss. |
| Medium | XEP-0085 | Chat State Notifications | Send `composing`/`active` so users see the bot is typing while it works. |
| Medium | XEP-0184 | Message Delivery Receipts | Mark inbound messages received; useful at-least-once semantics with agents. |
| Medium | XEP-0203 | Delayed Delivery | Timestamp offline/MUC-history messages so the agent sees correct ordering. |
| Low | XEP-0333 | Displayed Markers | Read receipts for a chat UI. |
| Low | XEP-0280 | Message Carbons | Keep multi-client sessions in sync. |
| Low | XEP-0313 | Message Archive Management | Server-side history / catch-up after downtime. |
| Low | XEP-0393 / XEP-0444 | Message Styling / Reactions | Nicer formatting and emoji reactions. |
| Low | XEP-0092 / XEP-0012 | Software Version / Last Activity | Standard client metadata and “last seen”. |

### Administrative XEPs excluded from prioritization

XEP-0001, XEP-0002, XEP-0019, XEP-0053, XEP-0134, XEP-0143, XEP-0458 are
process/SIG/registry documents, not client features; their “Not Supported”
status above carries no signal and they are intentionally omitted here.
