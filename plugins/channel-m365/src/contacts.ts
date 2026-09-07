import {
  contactsSearchOutputSchema,
  type Contact,
  type ContactsSearchInput,
  type ContactsSearchOutput,
} from "@borg/contracts";
import {
  GraphError,
  graphRequest,
  readString,
  type GraphClientOptions,
} from "./graph";
import {
  CONTACTS_DEFAULT_MAX_RESULTS,
  MAX_CONTACTS_QUERY,
  isEmailAddress,
  isRecord,
} from "./protocol";

const MAX_CONTACT_ID_LENGTH = 1_024;
const MAX_CONTACT_NAME_LENGTH = 512;
const MAX_CONTACT_EMAILS = 8;

export class GraphContactsClient {
  readonly #options: GraphClientOptions;

  constructor(options: GraphClientOptions) {
    this.#options = options;
  }

  async search(
    input: ContactsSearchInput,
    signal?: AbortSignal,
  ): Promise<ContactsSearchOutput> {
    const maxResults = input.maxResults ?? CONTACTS_DEFAULT_MAX_RESULTS;
    const params = new URLSearchParams({
      $top: String(maxResults),
      $select: "id,displayName,emailAddresses",
    });
    const query = input.query;
    if (query !== undefined) {
      if (query.length < 1 || query.length > MAX_CONTACTS_QUERY) {
        throw new GraphError(
          "invalid",
          undefined,
          "Contacts search query is invalid",
        );
      }
      params.set(
        "$filter",
        `startswith(displayName,'${escapeODataString(query)}')`,
      );
    }
    const body = await graphRequest(
      this.#options,
      `/v1.0/me/contacts?${params.toString()}`,
      { method: "GET", ...(signal ? { signal } : {}) },
    );
    if (!isRecord(body) || !Array.isArray(body.value)) {
      throw new GraphError(
        "invalid",
        undefined,
        "Graph returned an unusable contacts list",
      );
    }
    const contacts: Contact[] = [];
    for (const item of body.value) {
      const parsed = parseGraphContact(item);
      if (parsed && contacts.length < maxResults) {
        contacts.push(parsed);
      }
    }
    return contactsSearchOutputSchema.parse({ contacts });
  }
}

export function escapeODataString(value: string): string {
  return value.replaceAll("'", "''");
}

function parseGraphContact(value: unknown): Contact | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > MAX_CONTACT_ID_LENGTH
  ) {
    return undefined;
  }
  const emails = readGraphEmails(value.emailAddresses);
  const name = boundName(readString(value.displayName) ?? emails[0]);
  if (!name) {
    return undefined;
  }
  return { id: value.id, name, emails };
}

function readGraphEmails(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const emails: string[] = [];
  for (const item of value) {
    if (emails.length >= MAX_CONTACT_EMAILS) {
      break;
    }
    if (!isRecord(item)) {
      continue;
    }
    const address = readString(item.address);
    if (address && isEmailAddress(address)) {
      emails.push(address);
    }
  }
  return emails;
}

function boundName(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return value.length <= MAX_CONTACT_NAME_LENGTH
    ? value
    : value.slice(0, MAX_CONTACT_NAME_LENGTH);
}
