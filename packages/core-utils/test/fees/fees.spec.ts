import { expect } from '../setup'
import * as fees from '../../src/fees'

const hundredBillion = 10 ** 11
const tenThousand = 10 ** 4

describe('Fees', () => {
  it('should count zeros and ones', () => {
    const cases = [
      { input: Buffer.from('0001', 'hex'), zeros: 1, ones: 1 },
      { input: '0x0001', zeros: 1, ones: 1 },
      { input: '0x', zeros: 0, ones: 0 },
      { input: '0x1111', zeros: 0, ones: 2 },
    ]

    for (const test of cases) {
      const [zeros, ones] = fees.zeroesAndOnes(test.input)
      zeros.should.eq(test.zeros)
      ones.should.eq(test.ones)
    }
  })
})
