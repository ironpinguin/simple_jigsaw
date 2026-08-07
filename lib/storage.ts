// Image storage abstraction with two interchangeable drivers:
//   - "fs" : local filesystem (dev default, no external services needed)
//   - "s3" : any S3-compatible object store (RustFS in dev, S3 in prod)
//
// The rest of the app only ever calls putObject / getObject and never cares
// which driver is active. Switch drivers with the STORAGE_DRIVER env var.

import { promises as fs } from "fs";
import path from "path";

export interface StoredObject {
  body: Buffer;
  contentType: string;
}

const driver = (process.env.STORAGE_DRIVER ?? "fs").toLowerCase();

export function contentTypeForKey(key: string): string {
  const ext = path.extname(key).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
    default:
      return "image/webp";
  }
}

/* -------------------------------------------------------------------------- */
/* Filesystem driver                                                          */
/* -------------------------------------------------------------------------- */

function fsDir(): string {
  return path.resolve(process.env.STORAGE_FS_DIR ?? "./storage-data");
}

function fsPathFor(key: string): string {
  // Prevent path traversal: keys are app-generated but stay defensive.
  const safe = key.replace(/\.\.(\/|\\|$)/g, "");
  return path.join(fsDir(), safe);
}

async function fsPut(key: string, body: Buffer): Promise<void> {
  const full = fsPathFor(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
}

async function fsGet(key: string): Promise<StoredObject> {
  const body = await fs.readFile(fsPathFor(key));
  return { body, contentType: contentTypeForKey(key) };
}

async function fsDelete(key: string): Promise<void> {
  await fs.rm(fsPathFor(key), { force: true });
}

async function fsCopy(srcKey: string, destKey: string): Promise<void> {
  const dest = fsPathFor(destKey);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(fsPathFor(srcKey), dest);
}

/* -------------------------------------------------------------------------- */
/* S3 / MinIO driver (lazily loaded so fs-only setups need no AWS SDK)        */
/* -------------------------------------------------------------------------- */

async function s3Client() {
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? "true") === "true",
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    },
  });
}

function bucket(): string {
  return process.env.S3_BUCKET ?? "jigsaw";
}

async function ensureBucket() {
  const { HeadBucketCommand, CreateBucketCommand } = await import("@aws-sdk/client-s3");
  const client = await s3Client();
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket() }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket() }));
  }
}

async function s3Put(key: string, body: Buffer, contentType: string): Promise<void> {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  await ensureBucket();
  const client = await s3Client();
  await client.send(
    new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType }),
  );
}

async function s3Get(key: string): Promise<StoredObject> {
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await s3Client();
  const res = await client.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return {
    body: Buffer.from(bytes),
    contentType: res.ContentType ?? contentTypeForKey(key),
  };
}

async function s3Delete(key: string): Promise<void> {
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await s3Client();
  await client.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}

async function s3Copy(srcKey: string, destKey: string): Promise<void> {
  const { CopyObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await s3Client();
  // Objects only ever exist under app-minted keys (upload and rotation both
  // write `puzzles/<uuid>.<ext>`), and a copy can only name a key that has an
  // object — so CopySource needs no URL-encoding beyond joining bucket and key.
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket(),
      CopySource: `${bucket()}/${srcKey}`,
      Key: destKey,
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  return driver === "s3" ? s3Put(key, body, contentType) : fsPut(key, body);
}

export async function getObject(key: string): Promise<StoredObject> {
  return driver === "s3" ? s3Get(key) : fsGet(key);
}

export async function deleteObject(key: string): Promise<void> {
  return driver === "s3" ? s3Delete(key) : fsDelete(key);
}

/** Server-side copy so imageKey rotation never streams the bytes through the app. */
export async function copyObject(srcKey: string, destKey: string): Promise<void> {
  return driver === "s3" ? s3Copy(srcKey, destKey) : fsCopy(srcKey, destKey);
}
