/* External Imports */
import { Promise as bPromise } from 'bluebird'
import {
  ethers,
  Provider,
  Signer,
  toBeHex,
  toBigInt,
  toNumber,
  TransactionReceipt,
  TransactionRequest,
} from 'ethersv6'
import { Logger } from '@eth-optimism/common-ts'
import {
  encodeHex,
  L2Block,
  L2Transaction,
  MinioClient,
  MinioConfig,
  QueueOrigin,
  remove0x,
  sleep,
  toHexString,
  zlibCompressHexString,
} from '@metis.io/core-utils'

/* Internal Imports */
import { MpcClient, TransactionSubmitter } from '../utils'
import { InboxStorage } from '../storage'
import { TxSubmissionHooks } from '..'
import { ChannelManager } from '../da/channel-manager'
import {
  BatchToInbox,
  BatchToInboxElement,
  BatchToInboxRawTx,
  InboxBatchParams,
  TxData,
} from '../da/types'
import { CompressionAlgo } from '../da/channel-compressor'
import { MAX_BLOB_NUM_PER_TX, MAX_BLOB_SIZE, TX_GAS } from '../da/consts'
import { calcBlobFee } from '../da/eip4844'
import { SpanBatch } from '../da/span-batch'

export class TransactionBatchSubmitterInbox {
  private readonly minioClient: MinioClient
  private l1ChainId: bigint
  private l2ChainId: bigint

  constructor(
    readonly inboxStorage: InboxStorage,
    readonly inboxAddress: string,
    readonly l1Provider: Provider,
    readonly l2Provider: Provider,
    readonly logger: Logger,
    readonly maxTxSize: number,
    readonly useMinio: boolean,
    readonly minioConfig?: MinioConfig,
    readonly useBlob?: boolean
  ) {
    if (useMinio && minioConfig) {
      this.minioClient = new MinioClient(minioConfig)
    }
  }

  public async submitBatchToInbox(
    startBlock: number,
    endBlock: number,
    nextBatchIndex: number,
    metrics: any,
    signer: Signer,
    blobSigner: Signer,
    mpcUrl: string,
    shouldSubmitBatch: (sizeInBytes: number) => boolean,
    transactionSubmitter: TransactionSubmitter,
    blobTransactionSubmitter: TransactionSubmitter,
    hooks: TxSubmissionHooks,
    submitAndLogTx: (
      submitTransaction: () => Promise<TransactionReceipt>,
      successMessage: string,
      callback?: (
        receipt: TransactionReceipt | null,
        err: any
      ) => Promise<boolean>
    ) => Promise<TransactionReceipt>
  ): Promise<TransactionReceipt> {
    const params = await this._generateSequencerBatchParams(
      startBlock,
      endBlock,
      nextBatchIndex
    )
    if (!params) {
      throw new Error(
        `Cannot create sequencer batch with params start ${startBlock}, end ${endBlock} and next batch index ${nextBatchIndex}`
      )
    }

    const [batchParams, wasBatchTruncated] = params
    // encodeBatch of calldata for _shouldSubmitBatch
    let batchSizeInBytes = batchParams.inputData.length / 2
    this.logger.debug('Sequencer batch generated', {
      batchSizeInBytes,
    })

    if (this.useBlob) {
      // when using blob txs, need to calculate the blob txs size,
      // to avoid the situation that the batch is too small,
      // we will commit until at least one blob got included
      if (batchParams.blobTxData.length > 1) {
        batchSizeInBytes = 0
        for (const txData of batchParams.blobTxData) {
          batchSizeInBytes += txData.blobs.reduce(
            (acc, blob) => acc + blob.data.length,
            0
          )
        }
      }
    }

    // Only submit batch if one of the following is true:
    // 1. it was truncated
    // 2. it is large enough
    // 3. enough time has passed since last submission
    if (!wasBatchTruncated && !shouldSubmitBatch(batchSizeInBytes)) {
      return
    }
    metrics.numTxPerBatch.observe(endBlock - startBlock)
    const l1tipHeight = await signer.provider.getBlockNumber()
    this.logger.debug('Submitting batch to inbox.', {
      calldata: batchParams,
      l1tipHeight,
    })

    return this.submitSequencerBatch(
      nextBatchIndex,
      batchParams,
      signer,
      blobSigner,
      mpcUrl,
      transactionSubmitter,
      blobTransactionSubmitter,
      hooks,
      submitAndLogTx
    )
  }

  /*********************
   * Private Functions *
   ********************/

  private async submitSequencerBatch(
    nextBatchIndex: number,
    batchParams: InboxBatchParams,
    signer: Signer,
    // need the second signer for blob txs, since blob txs are in a separate tx pool,
    // in EIP4844, ethereum does not allow one account sending txs to multiple pools at the same time
    blobSigner: Signer,
    mpcUrl: string,
    transactionSubmitter: TransactionSubmitter,
    blobTransactionSubmitter: TransactionSubmitter,
    hooks: TxSubmissionHooks,
    submitAndLogTx: (
      submitTransaction: () => Promise<TransactionReceipt>,
      successMessage: string,
      callback?: (
        receipt: TransactionReceipt | null,
        err: any
      ) => Promise<boolean>
    ) => Promise<TransactionReceipt>
  ): Promise<TransactionReceipt> {
    // MPC enabled: prepare nonce, gasPrice
    const tx: TransactionRequest = {
      to: this.inboxAddress,
      data: '0x' + batchParams.inputData,
      value: ethers.parseEther('0'),
    }

    // use blob txs if batch params contains blob tx data
    const sendBlobTx = batchParams.blobTxData && batchParams.blobTxData.length
    if (sendBlobTx) {
      let mpcClient: MpcClient
      if (mpcUrl) {
        mpcClient = new MpcClient(mpcUrl)
      }

      const { chainId } = await signer.provider.getNetwork()
      // if using blob, we need to submit the blob txs before the inbox tx
      const blobTxData = batchParams.blobTxData
      // submit the blob txs in order, to simplify the process,
      // use serialized operations for now
      // TODO: use paralleled submission
      for (const txData of blobTxData) {
        const blobs = txData.blobs
        if (!blobs || !blobs.length) {
          throw new Error('Invalid blob tx data, empty blobs')
        }

        let signerAddress: string
        let mpcId: string
        if (mpcUrl) {
          // retrieve mpc info
          // blob tx need to use mpc type 3 (specific for blob tx) to sign,
          // just need to avoid collision with other tx types
          const currentMpcInfo = await mpcClient.getLatestMpc('3')
          if (!currentMpcInfo || !currentMpcInfo.mpc_address) {
            throw new Error('MPC info get failed')
          }
          signerAddress = currentMpcInfo.mpc_address
          mpcId = currentMpcInfo.mpc_id
        } else {
          signerAddress = await blobSigner.getAddress()
        }

        // async fetch required info
        const [latestBlockPromise, feeDataPromise, noncePromise] = [
          this.l1Provider.getBlock('latest'),
          this.l1Provider.getFeeData(),
          signer.provider.getTransactionCount(signerAddress),
        ]
        const [latestBlock, feeData, nonce] = await Promise.all([
          latestBlockPromise,
          feeDataPromise,
          noncePromise,
        ])

        const maxFeePerBlobGas = calcBlobFee(latestBlock.excessBlobGas)
        this.logger.info('submitting blob tx', {
          blobCount: blobs.length,
          maxFeePerBlobGas: toNumber(maxFeePerBlobGas),
          signerAddress,
          feeData,
          nonce,
        })

        const blobTx: ethers.TransactionRequest = {
          type: 3, // 3 for blob tx type
          to: this.inboxAddress,
          // since we are using blob tx, call data will be empty,
          // so the gas limit is just the default tx gas
          gasLimit: TX_GAS,
          chainId,
          nonce,
          blobs,
          blobVersionedHashes: blobs.map((blob) => blob.versionedHash),
          maxFeePerBlobGas,
          // use eip1559
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
        }

        // mpc model can use ynatm
        let submitTx: () => Promise<TransactionReceipt>
        if (mpcUrl) {
          submitTx = (): Promise<TransactionReceipt> => {
            return transactionSubmitter.submitSignedTransaction(
              blobTx,
              async () => {
                const signedTx = await mpcClient.signTx(blobTx, mpcId)
                // need to append the blob sidecar to the signed tx
                const signedTxUnmarshaled = ethers.Transaction.from(signedTx)
                // force set tx type to 3, just bypass the tx type inferring bug in ethers
                signedTxUnmarshaled.type = 3
                signedTxUnmarshaled.blobs = blobTx.blobs
                signedTxUnmarshaled.kzg = blobTx.kzg
                // repack the tx
                return signedTxUnmarshaled.serialized
              },
              hooks
            )
          }
        } else {
          submitTx = (): Promise<TransactionReceipt> => {
            try {
              return blobTransactionSubmitter.submitTransaction(blobTx, hooks)
            } catch (err) {
              this.logger.error('blob tx submission failed', { err })
              throw new Error('Blob tx submission failed')
            }
          }
        }

        const blobTxReceipt = await submitAndLogTx(
          submitTx,
          `Submitted blob tx with ${mpcUrl ? 'mpc' : 'local'} signer!`,
          async (
            receipt: TransactionReceipt | null,
            err: any
          ): Promise<boolean> => {
            this.logger.info('blob tx submission result', {
              success: receipt.status > 0,
              blockNumber: receipt.blockNumber,
              txIndex: receipt.index,
              txHash: receipt.hash,
              err,
            })
            return true
          }
        )

        if (!blobTxReceipt || blobTxReceipt.status !== 1) {
          throw new Error('Blob tx submission failed')
        }

        // append tx hashes to the tx data to the end
        tx.data += remove0x(blobTxReceipt.hash)
      }
    }

    // mpc url specified, use mpc to sign tx
    if (mpcUrl) {
      // sleep 3000 ms to avoid mpc signing collision
      this.logger.info('sleep 3000 ms to avoid mpc signing collision')
      await sleep(3000)

      this.logger.info('submitter with mpc', { url: mpcUrl })
      const mpcClient = new MpcClient(mpcUrl)
      const chainId = (await signer.provider.getNetwork()).chainId

      const mpcInfo = await mpcClient.getLatestMpc()
      if (!mpcInfo || !mpcInfo.mpc_address) {
        throw new Error('MPC info get failed')
      }
      const mpcAddress = mpcInfo.mpc_address

      tx.nonce = await signer.provider.getTransactionCount(mpcAddress)
      tx.gasLimit = await signer.provider.estimateGas({
        to: tx.to,
        from: mpcAddress,
        data: tx.data,
      })
      tx.chainId = chainId

      // mpc model can use ynatm
      const submitSignedTransaction = (): Promise<TransactionReceipt> => {
        return transactionSubmitter.submitSignedTransaction(
          tx,
          async (gasPrice) => {
            try {
              tx.gasPrice =
                gasPrice || (await this.l1Provider.getFeeData()).gasPrice
              const signedTx = await mpcClient.signTx(tx, mpcInfo.mpc_id)
              return signedTx
            } catch (e) {
              this.logger.error(`Error signing tx with mpc, ${e}`)
              throw e
            }
          },
          hooks
        )
      }

      return submitAndLogTx(
        submitSignedTransaction,
        'Submitted batch to inbox with MPC!',
        (receipt: TransactionReceipt | null, err: any): Promise<boolean> => {
          return this._setBatchInboxRecord(receipt, err, nextBatchIndex)
        }
      )
    } else {
      tx.nonce = await signer.getNonce()
      tx.gasLimit = await signer.provider.estimateGas({
        //estimate gas
        to: tx.to,
        from: await signer.getAddress(),
        data: tx.data,
      })
    }

    const submitTransaction = (): Promise<TransactionReceipt> => {
      return transactionSubmitter.submitTransaction(tx, hooks)
    }
    return submitAndLogTx(
      submitTransaction,
      'Submitted batch to inbox!',
      (receipt: TransactionReceipt | null, err: any): Promise<boolean> => {
        return this._setBatchInboxRecord(receipt, err, nextBatchIndex)
      }
    )
  }

  private async _setBatchInboxRecord(
    receipt: TransactionReceipt | null,
    err: any,
    batchIndex: number
  ): Promise<boolean> {
    let saveStatus = false
    if (receipt && (receipt.status === undefined || receipt.status === 1)) {
      saveStatus = await this.inboxStorage.recordConfirmedTx({
        batchIndex,
        blockNumber: receipt.blockNumber,
        txHash: receipt.hash,
      })
    } else {
      saveStatus = await this.inboxStorage.recordFailedTx(
        batchIndex,
        err.toString()
      )
    }
    return saveStatus
  }

  private async _generateSequencerBatchParams(
    startBlock: number,
    endBlock: number,
    nextBatchIndex: number
  ): Promise<[InboxBatchParams, boolean]> {
    // Get all L2 BatchElements for the given range
    const blockRange = endBlock - startBlock
    const batch: BatchToInbox = await bPromise.map(
      [...Array(blockRange).keys()],
      (i) => {
        this.logger.debug('Fetching L2BatchElement', {
          blockNo: startBlock + i,
        })
        return this._getL2BatchElement(startBlock + i)
      },
      { concurrency: 100 }
    )

    // fix max batch size with env
    const fixedMaxTxSize = this.maxTxSize

    let inboxBatchParams = await this._getSequencerBatchParams(
      startBlock,
      nextBatchIndex,
      batch
    )
    let wasBatchTruncated = false
    // This method checks encoded length without options anyway
    let encoded = inboxBatchParams.inputData
    while (encoded.length / 2 > fixedMaxTxSize) {
      this.logger.info('Splicing batch...', {
        batchSizeInBytes: encoded.length / 2,
      })
      batch.splice(Math.ceil((batch.length * 2) / 3)) // Delete 1/3rd of all of the batch elements
      inboxBatchParams = await this._getSequencerBatchParams(
        startBlock,
        nextBatchIndex,
        batch
      )
      encoded = inboxBatchParams.inputData
      //  This is to prevent against the case where a batch is oversized,
      //  but then gets truncated to the point where it is under the minimum size.
      //  In this case, we want to submit regardless of the batch's size.
      wasBatchTruncated = true
    }
    return [inboxBatchParams, wasBatchTruncated]
  }

  private async _loadChainIds() {
    if (!this.l1ChainId) {
      this.l1ChainId = (await this.l1Provider.getNetwork()).chainId
    }
    if (!this.l2ChainId) {
      this.l2ChainId = (await this.l2Provider.getNetwork()).chainId
    }
  }

  private async _getSequencerBatchParams(
    l2StartBlock: number,
    nextBatchIndex: number,
    blocks: BatchToInbox
  ): Promise<InboxBatchParams> {
    // [1: DA type] [1: compress type] [32: batch index] [32: L2 start] [4: total blocks, max 65535] [<DATA> { [3: txs count] [5 block timestamp = l1 timestamp of txs] [32 l1BlockNumber of txs, get it from tx0] [1: TX type 0-sequencer 1-enqueue] [3 tx data length] [raw tx data] [3 sign length *sequencerTx*] [sign data] [20 l1Origin *enqueue*] [32 queueIndex *enqueue*].. } ...]
    // DA: 0 - L1, 1 - memo, 2 - celestia, 3 - blob
    let da = encodeHex(0, 2)
    // Compress Type: 0 - none, 11 - zlib
    let compressType = encodeHex(11, 2)
    const batchIndex = encodeHex(nextBatchIndex, 64)
    const l2Start = encodeHex(l2StartBlock, 64)
    const totalElements = encodeHex(blocks.length, 8)

    let compressedEncoded = ''
    let encoded = ''
    const blobTxData: TxData[] = []

    if (!this.useBlob) {
      let encodeBlockData = ''
      blocks.forEach((inboxElement: BatchToInboxElement) => {
        // block encode, [3 txs count] [5 block timestamp = l1 timestamp of txs] [32 l1BlockNumber of txs, get it from tx0]
        // tx[0], [1 type 0 sequencerTx, 1 enqueue] [3 tx data length] [raw tx data] [3 sign length *sequencerTx*] [sign data] [20 l1Origin *enqueue*] [32 queueIndex *enqueue*]
        // for enqueue, queueIndex can use nonce, so not encode it
        encodeBlockData += encodeHex(inboxElement.txs.length, 6)
        encodeBlockData += encodeHex(inboxElement.timestamp, 10)

        let txIndex = 0
        inboxElement.txs.forEach((inboxTx: BatchToInboxRawTx) => {
          const curTx = inboxTx.rawTransaction
          if (curTx.length % 2 !== 0) {
            throw new Error('Unexpected uneven hex string value!')
          }
          if (txIndex === 0) {
            // put l1BlockNumber to block level info
            encodeBlockData += encodeHex(inboxTx.l1BlockNumber, 64)
          }
          txIndex++
          encodeBlockData += encodeHex(inboxTx.isSequencerTx ? 0 : 1, 2)
          if (inboxTx.isSequencerTx) {
            encodeBlockData += remove0x(
              toBeHex(toBigInt(remove0x(curTx).length / 2))
            ).padStart(6, '0')
            encodeBlockData += remove0x(curTx)
            encodeBlockData += remove0x(
              toBeHex(toBigInt(remove0x(inboxTx.seqSign).length / 2))
            ).padStart(6, '0')
            encodeBlockData += inboxTx.seqSign
          } else {
            // use 0 length
            encodeBlockData += remove0x(toBeHex(toBigInt('0'))).padStart(6, '0')
            encodeBlockData += remove0x(inboxTx.l1TxOrigin)
            const encodedNonce = encodeHex(inboxTx.queueIndex, 32)
            encodeBlockData += encodedNonce
          }
        })
      })

      try {
        compressedEncoded = await zlibCompressHexString(encodeBlockData)
      } catch (err) {
        this.logger.error('Zlib compress error', { err })
        throw new Error('Zlib compress encode blocks data error.')
      }

      if (this.useMinio && this.minioConfig) {
        if (!this.minioClient) {
          throw new Error('Can not initalize minio client.')
        }
        da = encodeHex(1, 2)

        // use block 0 state root as batch root
        const batchRoot = remove0x(blocks[0].stateRoot)

        // save compressedEncoed to memo storage
        const storagedObject = await this.minioClient.writeObject(
          batchRoot,
          l2StartBlock,
          blocks.length,
          compressedEncoded,
          3
        )
        this.logger.info('storage tx data to minio', { storagedObject })

        if (!storagedObject) {
          throw new Error(
            `Write to minio DA failed, l2StartBlock is ${l2StartBlock}.`
          )
        }
        compressedEncoded = storagedObject
      }
    } else {
      await this._loadChainIds()

      const channelManager = new ChannelManager(
        this.logger,
        {
          // since we are using blob here, so max frame size is the blob size
          maxFrameSize: MAX_BLOB_SIZE,
          // default to 6, this is the maximum number of blobs that a blob tx can carry
          targetFrames: MAX_BLOB_NUM_PER_TX,
          // default to unlimited
          maxBlocksPerSpanBatch: 0,
          // op's default is 1, if using blob, must be less than 6
          targetNumFrames: 1,
          // op's default is 0.6, value must between 0 and 1
          targetCompressorFactor: 0.6,
          // default to brotli after fjord
          compressionAlgo: CompressionAlgo.Brotli,
          // default to span batch after fjord
          batchType: SpanBatch.batchType(),
          // use blob txs
          useBlobs: true,
        },
        {
          l1ChainID: this.l1ChainId,
          l2ChainID: this.l2ChainId,
          batchInboxAddress: this.inboxAddress,
        },
        this.l1Provider
      )

      blocks.forEach((inboxElement: BatchToInboxElement) => {
        this.logger.debug(
          `Adding L2 block ${inboxElement.blockNumber} to channel manager`
        )
        channelManager.addL2Block(inboxElement)
      })

      const latestL1Block = await this.l1Provider.getBlockNumber()

      while (true) {
        const [txData, end] = await channelManager.txData(
          toBigInt(latestL1Block)
        )
        if (txData) {
          blobTxData.push(txData)
        }
        if (end) {
          this.logger.debug('No more tx data', { blobCount: blobTxData.length })
          break
        }
      }

      compressType = encodeHex(0, 2) // overwrite the compress type to not compressed
      da = encodeHex(3, 2) // overwrite da type to blob

      // for compressedEncoded, since we haven't sent the blob txs, so we need to leave it empty.
      // after we get the tx hashes, we will append the hashes to the compressedEncoded.
      // concat all tx hashes [32B Hash][32B Hash][...],
      // each tx contains a single frame of the submitted block,
      // when decoding, split the string by 64 to get the tx hashes array,
      // and use the tx hashes to get corresponding blobs from L1
    }
    // other da should here else

    encoded = `${da}${compressType}${batchIndex}${l2Start}${totalElements}${compressedEncoded}`
    return {
      inputData: encoded,
      batch: blocks,
      blobTxData,
    }
  }

  private async _getL2BatchElement(
    blockNumber: number
  ): Promise<BatchToInboxElement> {
    await this._loadChainIds()

    const block = await this._getBlock(blockNumber)
    this.logger.debug('Fetched L2 block', {
      block,
    })

    const batchElement: BatchToInboxElement = {
      stateRoot: block.stateRoot,
      timestamp: block.timestamp,
      blockNumber: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      txs: [],
    }

    block.l2Transactions.forEach((l2Tx: L2Transaction) => {
      const isSequencerTx = this._isSequencerTx(l2Tx)
      const batchElementTx: BatchToInboxRawTx = {
        rawTransaction: '',
        isSequencerTx,
        seqSign: '',
        l1BlockNumber: l2Tx.l1BlockNumber,
        l1TxOrigin: null,
        queueIndex: null,
      }
      if (batchElementTx.isSequencerTx) {
        batchElementTx.rawTransaction = l2Tx.rawTransaction
        if (!l2Tx.seqR) {
          batchElementTx.seqSign = ''
        } else {
          let r = remove0x(block.l2Transactions[0].seqR)
          let s = remove0x(block.l2Transactions[0].seqS)
          let v = remove0x(block.l2Transactions[0].seqV)
          if (r === '0') {
            r = '00'
          } else {
            r = this.padZerosToLeft(r)
          }
          if (s === '0') {
            s = '00'
          } else {
            s = this.padZerosToLeft(s)
          }
          if (v.length % 2 === 1) {
            v = `0${v}`
          }
          // restore: '' has no sign, '000000' is zero sign, `{64}{64}{n}` if n is 00, seqV is 0x0
          batchElementTx.seqSign = `${r}${s}${v}`
        }
      } else {
        batchElementTx.rawTransaction = ethers.Transaction.from({
          nonce: l2Tx.nonce,
          gasLimit: l2Tx.gasLimit,
          gasPrice: 0,
          to: l2Tx.to,
          value: 0,
          data: l2Tx.data,
          type: l2Tx.type,
          signature: {
            r: '0x0',
            s: '0x0',
            // need to assign the chainId to v, otherwise ethers will not be able to parse this tx
            // because enqueued tx is unsigned
            v: this.l2ChainId,
          },
        }).serialized
        batchElementTx.l1TxOrigin = l2Tx.l1TxOrigin
        batchElementTx.queueIndex = l2Tx.nonce
      }
      batchElement.txs.push(batchElementTx)
    })

    return batchElement
  }

  private async _getBlock(blockNumber: number): Promise<L2Block> {
    const p = await this.l2Provider.getBlock(blockNumber, true)
    const l2BLock = p as L2Block
    await Promise.all(l2BLock.l2TransactionPromises)
    return l2BLock
  }

  private _isSequencerTx(tx: L2Transaction): boolean {
    return tx.queueOrigin === QueueOrigin.Sequencer
  }

  private toRpcHexString(n: number): string {
    if (n === 0) {
      return '0x0'
    } else {
      // prettier-ignore
      return '0x' + toHexString(n).slice(2).replace(/^0+/, '')
    }
  }

  private padZerosToLeft(inputString: string): string {
    const targetLength = 64
    if (inputString.length >= targetLength) {
      return inputString
    }

    const zerosToPad = targetLength - inputString.length
    const paddedString = '0'.repeat(zerosToPad) + inputString
    return paddedString
  }
}
