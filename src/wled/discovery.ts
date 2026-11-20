import dgram from "node:dgram";
import { requestJson } from "./httpJson";
import { WledInfo } from "./types";

const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const WLED_SERVICE = "_wled._tcp.local";

export interface DiscoveredWled {
  baseUrl: URL;
  info: WledInfo;
}

export async function discoverWledControllers(
  options: {
    expectedMac?: string;
    timeoutMs?: number;
    requestTimeoutMs?: number;
  } = {},
): Promise<DiscoveredWled[]> {
  const candidates = await discoverMdnsCandidates(options.timeoutMs ?? 3_000);
  const uniqueCandidates = [...new Set(candidates)];
  const found: DiscoveredWled[] = [];

  await Promise.allSettled(
    uniqueCandidates.map(async (candidate) => {
      const baseUrl = normalizeCandidateUrl(candidate);
      const info = await requestJson<WledInfo>(baseUrl, "/json/info", {
        timeoutMs: options.requestTimeoutMs ?? 2_000,
      });

      if (options.expectedMac && !sameMac(info.mac, options.expectedMac)) {
        return;
      }

      if (isProbablyWled(info)) {
        found.push({ baseUrl, info });
      }
    }),
  );

  return found.sort((left, right) =>
    left.baseUrl.hostname.localeCompare(right.baseUrl.hostname),
  );
}

export function sameMac(left: string | undefined, right: string | undefined): boolean {
  return normalizeMac(left) !== "" && normalizeMac(left) === normalizeMac(right);
}

function discoverMdnsCandidates(timeoutMs: number): Promise<string[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const candidates = new Set<string>();
    const timer = setTimeout(() => {
      socket.removeAllListeners();
      socket.close();
      resolve([...candidates]);
    }, timeoutMs);

    socket.on("message", (message) => {
      for (const candidate of parseMdnsResponse(message)) {
        candidates.add(candidate);
      }
    });

    socket.on("error", () => {
      clearTimeout(timer);
      socket.close();
      resolve([...candidates]);
    });

    socket.bind(() => {
      try {
        socket.addMembership(MDNS_ADDRESS);
        socket.setMulticastTTL(1);
      } catch {
        // Some hosts do not allow joining the multicast group. Sending the
        // query can still work, so continue.
      }

      const query = createPtrQuery(WLED_SERVICE);
      socket.send(query, MDNS_PORT, MDNS_ADDRESS, (error) => {
        if (error) {
          clearTimeout(timer);
          socket.close();
          resolve([...candidates]);
        }
      });
    });
  });
}

function createPtrQuery(service: string): Buffer {
  const labels = service.split(".");
  const questionParts: Buffer[] = [];
  for (const label of labels) {
    questionParts.push(Buffer.from([label.length]));
    questionParts.push(Buffer.from(label, "ascii"));
  }
  questionParts.push(Buffer.from([0]));

  return Buffer.concat([
    Buffer.from([
      0x00, 0x00, // transaction id
      0x00, 0x00, // standard query
      0x00, 0x01, // questions
      0x00, 0x00, // answers
      0x00, 0x00, // authority
      0x00, 0x00, // additional
    ]),
    ...questionParts,
    Buffer.from([
      0x00, 0x0c, // PTR
      0x00, 0x01, // IN
    ]),
  ]);
}

function parseMdnsResponse(message: Buffer): string[] {
  if (message.length < 12) {
    return [];
  }

  const questions = message.readUInt16BE(4);
  const recordCount =
    message.readUInt16BE(6) +
    message.readUInt16BE(8) +
    message.readUInt16BE(10);
  let offset = 12;
  const srvTargets = new Set<string>();
  const addressesByName = new Map<string, string>();

  for (let index = 0; index < questions; index += 1) {
    const name = readDnsName(message, offset);
    if (!name) {
      return [];
    }
    offset = name.nextOffset + 4;
  }

  for (let index = 0; index < recordCount; index += 1) {
    const name = readDnsName(message, offset);
    if (!name || name.nextOffset + 10 > message.length) {
      break;
    }

    offset = name.nextOffset;
    const type = message.readUInt16BE(offset);
    offset += 2;
    offset += 2; // class
    offset += 4; // ttl
    const length = message.readUInt16BE(offset);
    offset += 2;
    const dataOffset = offset;
    const dataEnd = offset + length;
    if (dataEnd > message.length) {
      break;
    }

    if (type === 1 && length === 4) {
      addressesByName.set(
        name.value,
        `${message[dataOffset]}.${message[dataOffset + 1]}.${message[dataOffset + 2]}.${message[dataOffset + 3]}`,
      );
    } else if (type === 33 && dataOffset + 6 < dataEnd) {
      const target = readDnsName(message, dataOffset + 6);
      if (target) {
        srvTargets.add(target.value);
      }
    }

    offset = dataEnd;
  }

  const result = new Set<string>();
  for (const target of srvTargets) {
    result.add(target);
    const address = addressesByName.get(target);
    if (address) {
      result.add(address);
    }
  }

  return [...result];
}

function readDnsName(
  message: Buffer,
  startOffset: number,
  depth = 0,
): { value: string; nextOffset: number } | undefined {
  if (depth > 8) {
    return undefined;
  }

  const labels: string[] = [];
  let offset = startOffset;
  let nextOffset = startOffset;
  let jumped = false;

  while (offset < message.length) {
    const length = message[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= message.length) {
        return undefined;
      }
      const pointer = ((length & 0x3f) << 8) | message[offset + 1];
      const pointed = readDnsName(message, pointer, depth + 1);
      if (!pointed) {
        return undefined;
      }
      labels.push(pointed.value);
      if (!jumped) {
        nextOffset = offset + 2;
      }
      jumped = true;
      break;
    }

    if (length === 0) {
      if (!jumped) {
        nextOffset = offset + 1;
      }
      break;
    }

    const labelStart = offset + 1;
    const labelEnd = labelStart + length;
    if (labelEnd > message.length) {
      return undefined;
    }
    labels.push(message.subarray(labelStart, labelEnd).toString("ascii"));
    offset = labelEnd;
  }

  return { value: labels.join(".").replace(/\.$/, ""), nextOffset };
}

function normalizeCandidateUrl(candidate: string): URL {
  const host = candidate.endsWith(".local") ? candidate : candidate.replace(/\.$/, "");
  return new URL(`http://${host}/`);
}

function normalizeMac(value: string | undefined): string {
  return value?.replace(/[^a-fA-F0-9]/g, "").toLowerCase() ?? "";
}

function isProbablyWled(info: WledInfo): boolean {
  return (
    typeof info.ver === "string" &&
    (info.brand?.toLowerCase().includes("wled") ||
      info.product?.toLowerCase().includes("wled") ||
      typeof info.mac === "string")
  );
}
