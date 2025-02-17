/* Imports: External */
import { Contract, Signer, Provider, ethers } from 'ethersv6'
import { getContractDefinition } from '@metis.io/contracts'

export const loadContract = (
  name: string,
  address: string,
  provider: Provider
): Contract => {
  return new Contract(address, getContractDefinition(name).abi, provider)
}

export const loadProxyFromManager = async (
  name: string,
  proxy: string,
  Lib_AddressManager: Contract,
  provider: Provider
): Promise<Contract> => {
  const address = await Lib_AddressManager.getFunction('getAddress').staticCall(
    proxy
  )

  if (address === ethers.ZeroAddress) {
    throw new Error(
      `Lib_AddressManager does not have a record for a contract named: ${proxy}`
    )
  }

  return loadContract(name, address, provider)
}

export interface OptimismContracts {
  Lib_AddressManager: Contract
  StateCommitmentChain: Contract
  CanonicalTransactionChain: Contract
  Proxy__MVM_CanonicalTransaction: Contract
  Proxy__MVM_InboxSenderManager: Contract
}

export const loadOptimismContracts = async (
  l1RpcProvider: Provider,
  addressManagerAddress: string,
  signer?: Signer
): Promise<OptimismContracts> => {
  const Lib_AddressManager = loadContract(
    'Lib_AddressManager',
    addressManagerAddress,
    l1RpcProvider
  )

  const inputs = [
    {
      name: 'StateCommitmentChain',
      interface: 'IStateCommitmentChain',
    },
    {
      name: 'CanonicalTransactionChain',
      interface: 'ICanonicalTransactionChain',
    },
    // {
    //   name: 'CanonicalTransactionChain',
    //   interface: 'ICanonicalTransactionChain',
    // },
    {
      name: 'Proxy__MVM_CanonicalTransaction',
      interface: 'iMVM_CanonicalTransaction',
    },
    {
      name: 'Proxy__MVM_InboxSenderManager',
      interface: 'iMVM_InboxSenderManager',
    },
  ]

  const contracts = {}
  for (const input of inputs) {
    contracts[input.name] = await loadProxyFromManager(
      input.interface,
      input.name,
      Lib_AddressManager,
      l1RpcProvider
    )

    if (signer) {
      contracts[input.name] = contracts[input.name].connect(signer)
    }
  }

  contracts['Lib_AddressManager'] = Lib_AddressManager

  // TODO: sorry
  return contracts as OptimismContracts
}
