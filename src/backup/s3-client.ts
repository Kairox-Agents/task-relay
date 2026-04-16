/**
 * S3-compatible backup client using AWS SDK v3.
 * Supports: Backblaze B2, AWS S3, MinIO, Cloudflare R2, Wasabi.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  CopyObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import type { BackupConfig } from '../config/schema.js';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';

export interface BackupClientOptions {
  endpoint: string;
  region: string;
  bucket: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

export class BackupClient {
  private client: S3Client;
  private bucket: string;

  constructor(options: BackupClientOptions) {
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: options.credentials
        ? {
            accessKeyId: options.credentials.accessKeyId,
            secretAccessKey: options.credentials.secretAccessKey,
          }
        : undefined,
      forcePathStyle: !options.endpoint.includes('amazonaws.com'), // Path-style for non-AWS
    });
    this.bucket = options.bucket;
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async upload(key: string, data: Buffer | string, contentType = 'application/octet-stream'): Promise<void> {
    const body = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
  }

  async uploadFile(key: string, filePath: string, contentType = 'application/octet-stream'): Promise<void> {
    const body = createReadStream(filePath);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    );
  }

  async download(key: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    const stream = response.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  }

  async downloadToFile(key: string, filePath: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key })
    );
    const stream = response.Body as Readable;
    const writeStream = createWriteStream(filePath);
    await pipeline(stream, writeStream);
  }

  async list(prefix: string, maxKeys = 1000): Promise<{ key: string; lastModified?: Date; size?: number }[]> {
    const response = await this.client.send(
      new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: maxKeys })
    );
    return (response.Contents || []).map((obj) => ({
      key: obj.Key!,
      lastModified: obj.LastModified,
      size: obj.Size,
    }));
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    // S3 limits 1000 objects per delete request
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((k) => ({ Key: k })) },
        })
      );
    }
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0;
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        })
      );
      const objects = response.Contents || [];
      if (objects.length > 0) {
        await this.delete(objects.map((o) => o.Key!));
        deleted += objects.length;
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return deleted;
  }
}
