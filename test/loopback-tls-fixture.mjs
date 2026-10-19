import { generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";

// A short-lived, explicitly trusted loopback certificate. Keep private key
// material ephemeral instead of committing credentials or requiring OpenSSL.
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  const bytes = [];
  for (let length = body.length; length > 0; length >>>= 8) bytes.unshift(length & 255);
  const size = body.length < 128 ? [body.length] : [128 | bytes.length, ...bytes];
  return Buffer.concat([Buffer.from([tag, ...size]), body]);
}

const sequence = (...parts) => der(0x30, ...parts);
const oid = (...bytes) => der(0x06, Buffer.from(bytes));
const ecdsaSha256 = sequence(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));
const name = sequence(der(0x31, sequence(oid(0x55, 0x04, 0x03), der(0x0c, Buffer.from("localhost")))));
const time = (date) => der(0x18, Buffer.from(date.toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}Z$/, "Z")));

export function loopbackTlsCredentials() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const serial = randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 1;
  const now = Date.now();
  const subjectAltNames = sequence(
    der(0x82, Buffer.from("localhost")),
    der(0x87, Buffer.from([127, 0, 0, 1])),
  );
  const extensions = der(0xa3, sequence(
    sequence(oid(0x55, 0x1d, 0x11), der(0x04, subjectAltNames)),
  ));
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), // X.509 version 3
    der(0x02, serial), ecdsaSha256, name,
    sequence(time(new Date(now - 3_600_000)), time(new Date(now + 86_400_000))),
    name, publicKey.export({ type: "spki", format: "der" }), extensions,
  );
  const encoded = sequence(tbs, ecdsaSha256, der(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  const certificate = new X509Certificate(encoded);
  if (!certificate.verify(publicKey) || certificate.checkIP("127.0.0.1") !== "127.0.0.1") {
    throw new Error("Invalid generated loopback TLS fixture");
  }
  return { cert: certificate.toString(), key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}
