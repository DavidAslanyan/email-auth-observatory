import dgram from 'node:dgram';
import net from 'node:net';
import dnsPacket from 'dns-packet';
import { SYNTHETIC_RCODES, rcodeName, toLookupStatus } from './rcode.js';
import { joinTxtChunks } from './txt.js';
import type { DnsAnswer, MxAnswer, QueryOptions, RecordType } from './types.js';

export interface UdpTarget {
  host: string;
  port: number;
}

interface DecodedResponse {
  rcodeText: string;
  ad: boolean;
  truncated: boolean;
  txt: string[];
  mx: MxAnswer[];
  authority: string[];
  answerCount: number;
}

/**
 * A raw DNS query over UDP, falling back to TCP on truncation.
 *
 * node:dns is unusable for this project: it wraps c-ares and exposes neither
 * the RCODE (so NODATA and SERVFAIL are indistinguishable — see plan section
 * 1.1) nor the AD flag (so DNSSEC is lost entirely). Both are load-bearing
 * here, so the packets are built by hand.
 */
export async function queryUdp(
  target: UdpTarget,
  name: string,
  type: RecordType,
  options: QueryOptions,
): Promise<DnsAnswer> {
  const startedAt = performance.now();
  // A random transaction ID is the only thing distinguishing our answer from a
  // spoofed one on an unauthenticated UDP socket, so it is verified on receipt.
  const id = randomTransactionId();
  const packet = buildQuery(id, name, type, options.dnssecOk ?? true);

  try {
    const response = await sendUdp(target, dnsPacket.encode(packet), id, options.timeoutMs);

    if (response.truncated) {
      // Large TXT answers and DKIM keys routinely exceed what UDP will carry.
      const viaTcp = await sendTcp(target, dnsPacket.streamEncode(packet), id, options.timeoutMs);
      return toAnswer(viaTcp, startedAt);
    }

    return toAnswer(response, startedAt);
  } catch (error) {
    return failure(error, startedAt);
  }
}

function toAnswer(response: DecodedResponse, startedAt: number): DnsAnswer {
  return {
    status: toLookupStatus(response.rcodeText, response.answerCount),
    rcode: response.rcodeText,
    resolver: 'local',
    elapsedMs: Math.round(performance.now() - startedAt),
    ad: response.ad,
    txt: response.txt,
    mx: response.mx,
    authority: response.authority,
  };
}

function failure(error: unknown, startedAt: number): DnsAnswer {
  const rcode =
    error instanceof QueryTimeoutError ? SYNTHETIC_RCODES.timeout : SYNTHETIC_RCODES.networkError;
  return {
    // Whatever went wrong, it was ours. Never absence.
    status: 'unknown',
    rcode,
    resolver: 'local',
    elapsedMs: Math.round(performance.now() - startedAt),
    ad: false,
    txt: [],
    mx: [],
    authority: [],
  };
}

export class QueryTimeoutError extends Error {
  readonly code = 'DNS_TIMEOUT';
  constructor(name: string) {
    super(`DNS query timed out: ${name}`);
    this.name = 'QueryTimeoutError';
  }
}

export class QueryNetworkError extends Error {
  readonly code = 'DNS_NETWORK_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'QueryNetworkError';
  }
}

function randomTransactionId(): number {
  return Math.floor(Math.random() * 0x10000);
}

function buildQuery(
  id: number,
  name: string,
  type: RecordType,
  dnssecOk: boolean,
): dnsPacket.Packet {
  return {
    type: 'query',
    id,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type, name }],
    // EDNS0 with the DO bit: without it the resolver never sets AD, and the
    // 512-byte default payload size forces a TCP retry on most TXT answers.
    additionals: [
      {
        type: 'OPT',
        name: '.',
        udpPayloadSize: 4096,
        flags: dnssecOk ? dnsPacket.DNSSEC_OK : 0,
        extendedRcode: 0,
        ednsVersion: 0,
        flag_do: dnssecOk,
        options: [],
      },
    ],
  };
}

async function sendUdp(
  target: UdpTarget,
  request: Buffer,
  id: number,
  timeoutMs: number,
): Promise<DecodedResponse> {
  return new Promise<DecodedResponse>((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    // One ephemeral socket per query. A leaked socket exhausts file descriptors
    // around query 1000 and the crawl dies hours in with a confusing EMFILE, so
    // every exit path runs finish().
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new QueryTimeoutError(target.host));
      });
    }, timeoutMs);

    socket.on('message', (message) => {
      let decoded;
      try {
        decoded = dnsPacket.decode(message);
      } catch {
        return; // Garbage on the wire; keep waiting for a valid answer.
      }
      // Discard anything that is not the answer we asked for.
      if (decoded.id !== id) return;
      finish(() => {
        resolve(decodeResponse(decoded));
      });
    });

    socket.on('error', (error) => {
      finish(() => {
        reject(new QueryNetworkError(error.message));
      });
    });

    socket.send(request, target.port, target.host, (error) => {
      if (error) {
        finish(() => {
          reject(new QueryNetworkError(error.message));
        });
      }
    });
  });
}

async function sendTcp(
  target: UdpTarget,
  framed: Buffer,
  id: number,
  timeoutMs: number,
): Promise<DecodedResponse> {
  return new Promise<DecodedResponse>((resolve, reject) => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    const chunks: Buffer[] = [];
    let received = 0;
    let expected = -1;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => {
        reject(new QueryTimeoutError(target.host));
      });
    }, timeoutMs);

    socket.on('connect', () => void socket.write(framed));

    socket.on('data', (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      // RFC 1035 section 4.2.2: each TCP message is prefixed with its length.
      if (expected === -1 && received >= 2) expected = Buffer.concat(chunks).readUInt16BE(0);
      if (expected === -1 || received < expected + 2) return;

      try {
        const decoded = dnsPacket.streamDecode(Buffer.concat(chunks).subarray(0, expected + 2));
        if (decoded.id !== id) {
          finish(() => {
            reject(new QueryNetworkError('transaction id mismatch over TCP'));
          });
          return;
        }
        finish(() => {
          resolve(decodeResponse(decoded));
        });
      } catch (error) {
        finish(() => {
          reject(new QueryNetworkError(error instanceof Error ? error.message : 'decode failed'));
        });
      }
    });

    socket.on('error', (error) => {
      finish(() => {
        reject(new QueryNetworkError(error.message));
      });
    });

    socket.on('close', () => {
      finish(() => {
        reject(new QueryNetworkError('TCP connection closed before a full response'));
      });
    });
  });
}

/**
 * dns-packet sets `rcode` to a name string on every decoded packet, but its
 * published types omit the field. Widening here keeps the cast in one place
 * instead of scattering it through the decode path.
 */
type DecodedPacket = Omit<dnsPacket.DecodedPacket, 'flag_ad' | 'flag_tc'> & {
  rcode?: string | number;
  // streamDecode is typed as returning a bare Packet, so the flags may be
  // absent on that path even though dns-packet does set them.
  flag_ad?: boolean;
  flag_tc?: boolean;
};

export function decodeResponse(
  packet: dnsPacket.Packet | dnsPacket.DecodedPacket,
): DecodedResponse {
  const decoded = packet as DecodedPacket;
  const answers = decoded.answers ?? [];
  const txt: string[] = [];
  const mx: MxAnswer[] = [];

  for (const answer of answers) {
    if (answer.type === 'TXT') {
      txt.push(joinTxtChunks(answer.data));
    } else if (answer.type === 'MX') {
      // dns-packet types preference as optional; MX records always carry one,
      // and 0 is the correct reading of its absence (highest priority).
      mx.push({ preference: answer.data.preference ?? 0, exchange: answer.data.exchange });
    }
  }

  const authority = (decoded.authorities ?? [])
    .filter((record) => record.type === 'SOA' || record.type === 'NS')
    .map((record) => record.name);

  const rcodeText =
    typeof decoded.rcode === 'string'
      ? decoded.rcode
      : rcodeName(typeof decoded.rcode === 'number' ? decoded.rcode : -1);

  return {
    rcodeText,
    ad: decoded.flag_ad === true,
    truncated: decoded.flag_tc === true,
    txt,
    mx,
    authority,
    // Answer count drives the ok-vs-nodata distinction, so it counts records
    // actually returned, not records of the type we asked for.
    answerCount: answers.length,
  };
}
