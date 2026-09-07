import {
  contactsSearchOutputSchema,
  type Contact,
  type ContactsSearchInput,
  type ContactsSearchOutput,
} from "@borg/contracts";
import {
  GoogleApisError,
  isRecord,
  readString,
  type GoogleApisClientOptions,
} from "./googleapis";
import { peopleRequest } from "./people";
import {
  CONTACTS_DEFAULT_MAX_RESULTS,
  MAX_CONTACTS_QUERY,
  isEmailAddress,
} from "./protocol";

const MAX_CONTACT_ID_LENGTH = 1_024;
const MAX_CONTACT_NAME_LENGTH = 512;
const MAX_CONTACT_EMAILS = 8;
const PERSON_FIELDS = "names,emailAddresses";

export class GoogleContactsClient {
  readonly #options: GoogleApisClientOptions;

  constructor(options: GoogleApisClientOptions) {
    this.#options = options;
  }

  async search(
    input: ContactsSearchInput,
    signal?: AbortSignal,
  ): Promise<ContactsSearchOutput> {
    const maxResults = input.maxResults ?? CONTACTS_DEFAULT_MAX_RESULTS;
    const query = input.query;
    const init = { method: "GET", ...(signal ? { signal } : {}) };
    if (query !== undefined) {
      if (query.length < 1 || query.length > MAX_CONTACTS_QUERY) {
        throw new GoogleApisError(
          "invalid",
          undefined,
          "Google contacts search query is invalid",
        );
      }
      const params = new URLSearchParams({
        query,
        pageSize: String(maxResults),
        readMask: PERSON_FIELDS,
      });
      const body = await peopleRequest(
        this.#options,
        `/v1/people:searchContacts?${params.toString()}`,
        init,
      );
      return parseSearchResults(body, maxResults);
    }
    const params = new URLSearchParams({
      pageSize: String(maxResults),
      personFields: PERSON_FIELDS,
    });
    const body = await peopleRequest(
      this.#options,
      `/v1/people/me/connections?${params.toString()}`,
      init,
    );
    return parseConnections(body, maxResults);
  }
}

function parseSearchResults(
  body: unknown,
  maxResults: number,
): ContactsSearchOutput {
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new GoogleApisError(
      "invalid",
      undefined,
      "Google returned an unusable contacts list",
    );
  }
  const contacts: Contact[] = [];
  for (const item of body.results) {
    const person = isRecord(item) ? item.person : undefined;
    const parsed = parsePerson(person);
    if (parsed && contacts.length < maxResults) {
      contacts.push(parsed);
    }
  }
  return contactsSearchOutputSchema.parse({ contacts });
}

function parseConnections(
  body: unknown,
  maxResults: number,
): ContactsSearchOutput {
  if (!isRecord(body) || !Array.isArray(body.connections)) {
    throw new GoogleApisError(
      "invalid",
      undefined,
      "Google returned an unusable contacts list",
    );
  }
  const contacts: Contact[] = [];
  for (const item of body.connections) {
    const parsed = parsePerson(item);
    if (parsed && contacts.length < maxResults) {
      contacts.push(parsed);
    }
  }
  return contactsSearchOutputSchema.parse({ contacts });
}

function parsePerson(value: unknown): Contact | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readString(value.resourceName);
  if (!id || id.length > MAX_CONTACT_ID_LENGTH) {
    return undefined;
  }
  const emails = readPersonEmails(value.emailAddresses);
  const name = boundName(readPersonName(value) ?? emails[0]);
  if (!name) {
    return undefined;
  }
  return { id, name, emails };
}

function readPersonName(value: Record<string, unknown>): string | undefined {
  const names = Array.isArray(value.names) ? value.names : [];
  const first = names[0];
  if (!isRecord(first)) {
    return undefined;
  }
  const displayName = readString(first.displayName);
  if (displayName) {
    return displayName;
  }
  const given = readString(first.givenName);
  const family = readString(first.familyName);
  const combined = [given, family].filter((part) => part !== undefined).join(" ");
  return combined.length > 0 ? combined : undefined;
}

function readPersonEmails(value: unknown): string[] {
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
    const address = readString(item.value);
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
