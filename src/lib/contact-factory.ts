import path from "path";
import fs from "fs";
import { Contacts } from "../contacts.js";

let _contactsInstance: Contacts | null = null;

export async function getContactsInstance(): Promise<Contacts> {
  if (_contactsInstance) return _contactsInstance;

  const dataDir = process.env.OPENCLAW_DATA || path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  _contactsInstance = new Contacts(dataDir);
  return _contactsInstance;
}
