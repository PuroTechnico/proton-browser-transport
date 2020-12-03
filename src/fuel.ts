import type {LinkSession} from 'anchor-link'
import {Signature, SigningRequest} from 'anchor-link'

const supportedChains = {
    'aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906':
        'https://eos.greymass.com',
    '2a02a0053e5a8cf73a56ba0fda11e4d92e0238a4a2aa74fccf46d5a910746840':
        'https://jungle3.greymass.com',
    '4667b205c6838ef70ff7988f6e8257e8be0e1284a2f59699054a018f743b1d11':
        'https://telos.greymass.com',
}

async function apiCall(url: string, body?: any) {
    return (
        await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        })
    ).json()
}

export async function fuel(
    request: SigningRequest,
    session: LinkSession,
    updatePrepareStatus: (message: string) => void,
    fuelReferrer: string = 'teamgreymass'
) {
    updatePrepareStatus('Detecting if Fuel is required.')
    const chainId = request.getChainId()
    const nodeUrl = supportedChains[String(chainId)]
    if (!nodeUrl) {
        throw new Error('Chain does not support Fuel.')
    }
    const result = await apiCall(nodeUrl + '/v1/cosigner/sign', {
        ref: fuelReferrer,
        request,
        signer: session.auth,
    })
    const cloned = request.clone()
    if (result.data.signatures[0]) {
        if (result.code === 402) {
            cloned.setInfoKey('fuel_fee', result.data.fee)
        }
        cloned.setInfoKey('cosig', Signature.from(result.data.signatures[0]))
    } else {
        throw new Error('No signature returned from Fuel')
    }
    cloned.data.req = (
        await SigningRequest.create(
            {transaction: result.data.request[1]},
            {abiProvider: (request as any).abiProvider}
        )
    ).data.req
    return cloned
}
