import { createHash } from 'crypto'
import {
  Blob as CBlob,
  blobToKzgCommitment,
  Bytes48,
  computeBlobKzgProof,
  verifyBlobKzgProof,
} from 'c-kzg'
import { Frame } from './types'

const BlobSize = 4096 * 32
const MaxBlobDataSize = (4 * 31 + 3) * 1024 - 4
const EncodingVersion = 0
const VersionOffset = 1
const Rounds = 1024

export class Blob {
  public readonly data: Uint8Array = new Uint8Array(BlobSize)
  public readonly commitment: Bytes48 = new Uint8Array(48)
  public readonly proof: Bytes48 = new Uint8Array(48)
  public versionedHash: string = ''

  static kzgToVersionedHash(commitment: Bytes48): string {
    const hasher = createHash('sha256')
    hasher.update(commitment)
    // versioned hash = [1 byte version][31 byte hash]
    return '0x01' + hasher.digest('hex').substring(2)
  }

  static verifyBlobProof(
    blob: Blob,
    commitment: Bytes48,
    proof: Bytes48
  ): boolean {
    return verifyBlobKzgProof(blob.data as CBlob, commitment, proof)
  }

  marshalFrame(frame: Frame): Uint8Array {
    const buffer = new ArrayBuffer(16 + 2 + 4 + frame.data.length + 1)
    const view = new DataView(buffer)
    let offset = 0

    // Write id (16 bytes)
    new Uint8Array(buffer, offset, 16).set(frame.id)
    offset += 16

    // Write frameNumber (2 bytes, big-endian)
    view.setUint16(offset, frame.frameNumber, false)
    offset += 2

    // Write data length (4 bytes, big-endian)
    view.setUint32(offset, frame.data.length, false)
    offset += 4

    // Write data
    new Uint8Array(buffer, offset, frame.data.length).set(frame.data)
    offset += frame.data.length

    // Write isLast (1 byte)
    view.setUint8(offset, frame.isLast ? 1 : 0)

    return new Uint8Array(buffer)
  }

  fromFrame(frame: Frame): Blob {
    // set first byte as derivation version 0
    const data = Buffer.concat([Buffer.from([0x0]), this.marshalFrame(frame)])
    if (data.length > MaxBlobDataSize) {
      throw new Error(`Input too large: len=${data.length}`)
    }
    this.clear()

    let readOffset = 0
    const read1 = (): number => {
      if (readOffset >= data.length) {
        return 0
      }
      return data[readOffset++]
    }

    let writeOffset = 0
    const buf31 = new Uint8Array(31)
    const zero31 = new Uint8Array(31)

    const read31 = (): void => {
      if (readOffset >= data.length) {
        buf31.set(zero31)
        return
      }
      const n = Math.min(31, data.length - readOffset)
      buf31.set(data.subarray(readOffset, readOffset + n))
      if (n < 31) {
        buf31.set(zero31.subarray(0, 31 - n), n)
      }
      readOffset += n
    }

    const write1 = (v: number): void => {
      if (writeOffset % 32 !== 0) {
        throw new Error(`Invalid byte write offset: ${writeOffset}`)
      }
      if (v & 0b1100_0000) {
        throw new Error(`Invalid 6 bit value: 0b${v.toString(2)}`)
      }
      this.data[writeOffset++] = v
    }

    const write31 = (): void => {
      if (writeOffset % 32 !== 1) {
        throw new Error(`Invalid bytes31 write offset: ${writeOffset}`)
      }
      this.data.set(buf31, writeOffset)
      writeOffset += 31
    }

    for (let round = 0; round < Rounds && readOffset < data.length; round++) {
      if (round === 0) {
        buf31[0] = EncodingVersion
        const ilen = data.length
        buf31[1] = (ilen >> 16) & 0xff
        buf31[2] = (ilen >> 8) & 0xff
        buf31[3] = ilen & 0xff
        const dataToCopy = data.subarray(0, 27)
        buf31.set(dataToCopy, 4)
        if (dataToCopy.length < 27) {
          buf31.set(
            zero31.subarray(0, 27 - dataToCopy.length),
            4 + dataToCopy.length
          )
        }
        readOffset += dataToCopy.length
      } else {
        read31()
      }

      const x = read1()
      write1(x & 0b0011_1111)
      write31()

      read31()
      const y = read1()
      write1((y & 0b0000_1111) | ((x & 0b1100_0000) >> 2))
      write31()

      read31()
      const z = read1()
      write1(z & 0b0011_1111)
      write31()

      read31()
      write1(((z & 0b1100_0000) >> 2) | ((y & 0b1111_0000) >> 4))
      write31()
    }

    if (readOffset < data.length) {
      throw new Error(
        `Expected to fit data but failed, read offset: ${readOffset}, data length: ${data.length}`
      )
    }

    this.commitment.set(blobToKzgCommitment(this.data as CBlob))
    this.proof.set(computeBlobKzgProof(this.data as CBlob, this.commitment))
    this.versionedHash = Blob.kzgToVersionedHash(this.commitment)

    return this
  }

  toString(): string {
    return Buffer.from(this.data).toString('hex')
  }

  terminalString(): string {
    return `${Buffer.from(this.data.slice(0, 3)).toString(
      'hex'
    )}..${Buffer.from(this.data.slice(BlobSize - 3)).toString('hex')}`
  }

  clear(): void {
    this.data.fill(0)
  }
}
