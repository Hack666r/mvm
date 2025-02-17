// channel.ts
import { ethers } from 'ethersv6'
import { ChannelBuilder } from './channel-builder'
import {
  BatchToInboxElement,
  ChannelConfig,
  Frame,
  RollupConfig,
  TxData,
} from './types'
import { Blob } from './blob'
import { Logger } from '@eth-optimism/common-ts'

export class Channel {
  private channelBuilder: ChannelBuilder
  private pendingTransactions: Map<string, TxData> = new Map()
  private confirmedTransactions: Map<string, number> = new Map()
  private failedTransactions: Map<string, TxData> = new Map()

  constructor(
    private logger: Logger,
    private cfg: ChannelConfig,
    rollupCfg: RollupConfig,
    l1Client: ethers.Provider
  ) {
    this.channelBuilder = new ChannelBuilder(
      this.logger,
      cfg,
      rollupCfg,
      l1Client
    )
  }

  id(): Uint8Array {
    return this.channelBuilder.spanChannelOut.id
  }

  hasTxData(): boolean {
    return this.channelBuilder.hasFrame()
  }

  nextTxData(): [TxData, boolean] {
    let end = false
    const frames: Frame[] = []
    for (let i = 0; i < this.cfg.targetFrames; i++) {
      const [frame, frameEnd] = this.channelBuilder.nextFrame()
      this.logger.debug('generated frame', {
        length: frame.data.length,
      })
      if (frame) {
        frames.push(frame)
      }
      if (frameEnd) {
        // no more frames, we're done here,
        // notify upper layer there is no more tx data
        end = true
        this.logger.debug('no more frames')
        break
      }
    }
    const txData: TxData = {
      frames,
      asBlob: this.cfg.useBlobs,

      get id(): string {
        let sb = ''
        let curChID = ''
        this.frames.forEach((f) => {
          const chIDStringer = (id: Uint8Array) =>
            Buffer.from(id).toString('hex')
          const frameIdHex = chIDStringer(f.id)
          if (frameIdHex === curChID) {
            sb += `+${f.frameNumber}`
          } else {
            if (curChID !== '') {
              sb += '|'
            }
            curChID = frameIdHex
            sb += `${chIDStringer(f.id)}:${f.frameNumber}`
          }
        })
        return sb
      },

      get blobs(): Blob[] {
        return this.frames.map((f: Frame) => new Blob().fromFrame(f))
      },
    }
    this.pendingTransactions.set(txData.id, txData)
    return [txData, end]
  }

  async addBlock(block: BatchToInboxElement): Promise<void> {
    await this.channelBuilder.addBlock(block)
  }

  isFull(): boolean {
    return this.channelBuilder.isFull()
  }

  inputBytes(): number {
    return this.channelBuilder.spanChannelOut.inputBytes()
  }

  readyBytes(): number {
    return this.channelBuilder.spanChannelOut.readyBytes()
  }

  pendingFrames(): number {
    return this.channelBuilder.pendingFrames()
  }

  latestL1Origin(): number {
    return this.channelBuilder.latestL1Origin
  }

  oldestL1Origin(): number {
    return this.channelBuilder.oldestL1Origin
  }

  latestL2(): number {
    return this.channelBuilder.latestL2
  }

  oldestL2(): number {
    return this.channelBuilder.oldestL2
  }

  async close(): Promise<void> {
    await this.channelBuilder.spanChannelOut.close()
  }

  noneSubmitted(): boolean {
    return (
      this.pendingTransactions.size === 0 &&
      this.confirmedTransactions.size === 0
    )
  }

  txFailed(id: string): void {
    const txData = this.pendingTransactions.get(id)
    if (txData) {
      this.pendingTransactions.delete(id)
      this.failedTransactions.set(id, txData)
    }
  }

  txConfirmed(id: string, inclusionBlock: number): void {
    this.pendingTransactions.delete(id)
    this.confirmedTransactions.set(id, inclusionBlock)
  }
}
