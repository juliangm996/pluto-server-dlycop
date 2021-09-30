'use strict';

const Moralis = require('moralis/node');
const {providers, utils, Contract, Wallet} = require('ethers');

const MORALIS_APPID = process.env.MORALIS_APPID;
const MORALIS_SERVER_URL = process.env.MORALIS_SERVER_URL;
const RPC_URL = process.env.RPC_URL;
const NETWORK = process.env.NETWORK;

const {
	abi: tokenContractAbiTest,
	address: tokenContractAddressTest,
} = require('../../blockchain/dlycop/deployments/mumbai/DailyCopTokenChild.json');

const {
	abi: relayerContractAbiTest,
	address: relayerContractAddressTest,
} = require('../../blockchain/dlycop/deployments/mumbai/Relayer.json');

const {
	abi: tokenContractAbiMain,
	address: tokenContractAddressMain,
} = require('../../blockchain/dlycop/deployments/polygon/DailyCopTokenChild.json');

const {
	abi: relayerContractAbiMain,
	address: relayerContractAddressMain,
} = require('../../blockchain/dlycop/deployments/polygon/Relayer.json');

// const gasStationUrl =
// 	process.env.NODE_ENV === 'development'
// 		? 'https://gasstation-mumbai.matic.today'
// 		: 'https://gasstation-mainnet.matic.network';

const ContractByNetwork = {
	TESTNET: {
		token: {
			abi: tokenContractAbiTest,
			address: tokenContractAddressTest,
		},
		relayer: {
			abi: relayerContractAbiTest,
			address: relayerContractAddressTest,
		},
	},
	MAINNET: {
		token: {
			abi: tokenContractAbiMain,
			address: tokenContractAddressMain,
		},
		relayer: {
			abi: relayerContractAbiMain,
			address: relayerContractAddressMain,
		},
	},
};

// pkey is the private key of the wallet we created for the order and that currently has DLYCOP
// amount is the parsed amount received from the order, for example an order of 10.000 DLYCOP, amount is ~~utils.formatEther("10000");
const signTx = async (pkey = '', amount, recipientAddress = '') => {
	const {token, relayer} = ContractByNetwork[NETWORK];
	const provider = new providers.JsonRpcProvider(RPC_URL);
	const signer = new Wallet(pkey, provider);
	const parsedAmount = utils.parseEther(amount.toString());

	const network = await provider.getNetwork();
	const chainId = network.chainId;
	const deadline = Date.now() + 3600;
	const gasProvider = await provider.getGasPrice();
	const gasPrice = gasProvider * 10;

	const contract = new Contract(token.address, token.abi, provider);

	const nonce = await contract.nonces(signer.address);

	const domain = {
		name: 'DailyCopToken',
		version: '1',
		chainId,
		verifyingContract: contract.address,
	};

	const values = {
		owner: signer.address,
		spender: relayer.address,
		value: String(amount),
		nonce: nonce,
		deadline,
	};

	const types = {
		Permit: [
			{name: 'owner', type: 'address'},
			{name: 'spender', type: 'address'},
			{name: 'value', type: 'uint256'},
			{name: 'nonce', type: 'uint256'},
			{name: 'deadline', type: 'uint256'},
		],
	};

	const res = await signer._signTypedData(domain, types, values);
	const signature = res.substring(2);
	const r = '0x' + signature.substring(0, 64);
	const s = '0x' + signature.substring(64, 128);
	const v = parseInt(signature.substring(128, 130), 16);

	const relayerContract = new Contract(relayer.address, relayer.abi, provider);

	// We've tried estimating gas from provider passing "values" as input to simulate
	// and passing our own values to debug
	const gasLimit = await provider
		.estimateGas(values)
		.then((estimate) => estimate);

	const txResult = await relayerContract
		.connect(signer)
		.transferWithPermit(
			signer.address,
			recipientAddress,
			String(parsedAmount),
			deadline,
			v,
			r,
			s,
			{gasPrice, gasLimit}
		)
		.then((txRes) => console.log('txRes :>> ', txRes))
		.catch((error) => console.log('error transferWithPermit :>> ', error));
	console.log('txResult :>> ', txResult);
};

// Here we initialize our "validate order" logic which will be receive updates from Moralis LiveQuery
// This function is called in our server's bootstrap service which will run before the server gets started
// It is always listenning to DLYCOP transactions on the network.
const RunMoralisWatcher = async () => {
	Moralis.initialize(MORALIS_APPID);
	Moralis.serverURL = MORALIS_SERVER_URL;
	const queryTransfers = new Moralis.Query('TransfersDLYCOP');
	const subscription = await queryTransfers.subscribe();
	subscription.on('update', async (data) => {
		const address = data.attributes.to;
		const valueReceived = ~~utils.formatEther(data.attributes.value);
		const orderToValidate = await strapi
			.query('order')
			.find({temp_address_contains: address});

		if (orderToValidate[0]) {
			const body = {
				payload: {
					dest: orderToValidate[0].temp_address,
					source: data.attributes.from,
					message: '',
					metadata: {},
					currency: 'DLYCOP',
					amount: valueReceived,
					createdAt: new Date(orderToValidate[0].createdAt).getTime(),
					confirmedAt: Date.now(),
					orderRef: orderToValidate[0].ref,
				},
				user: orderToValidate[0].user,
			};
			if (
				orderToValidate[0].status === 'pending' &&
				data.attributes.confirmed === true &&
				valueReceived === orderToValidate[0].amount_in
			) {
				await strapi.query('order').update(
					{id: orderToValidate[0].id},
					{
						transfer_id: data.attributes.objectId,
						status: 'completed',
						hash_status: 'confirmed',
						hash: data.attributes.transaction_hash,
					}
				);

				const temp_wallet = await strapi
					.query('temporal-wallet')
					.find({address: orderToValidate[0].temp_address});

				try {
					await signTx(
						temp_wallet[0].pkey,
						valueReceived,
						merchantInfo[0].billing.wallet_address
					);
				} catch (error) {
					console.log('error signTx :>> ', error);
				}
				body.payload.status = 'CONFIRMED';
				const entity = await strapi.services.notification.create(body);
				const socket = await strapi
					.query('connection')
					.find({userID: orderToValidate[0].user.id});
				if (socket.length > 0 && socket[0].socketID != null) {
					strapi.io.to(socket[0].socketID).emit('message', {
						entity,
					});
				}
				return;
			} else if (
				orderToValidate[0].status === 'pending' &&
				data.attributes.confirmed === true &&
				valueReceived !== orderToValidate[0].amount_in
			) {
				await strapi.query('order').update(
					{id: orderToValidate[0].id},
					{
						transfer_id: data.attributes.objectId,
						status: 'rejected',
						hash_status: 'rejected',
						hash: data.attributes.transaction_hash,
					}
				);
				body.payload.status = 'REJECTED';
				const entity = await strapi.services.notification.create(body);
				const socket = await strapi
					.query('connection')
					.find({userID: orderToValidate[0].user.id});
				if (socket.length > 0 && socket[0].socketID != null) {
					strapi.io.to(socket[0].socketID).emit('message', {
						entity,
					});
				}
				return;
			}
		}
		return;
	});
};

/**
 * An asynchronous bootstrap function that runs before
 * your application gets started.
 *
 * This gives you an opportunity to set up your data model,
 * run jobs, or perform some special logic.
 *
 * See more details here: https://strapi.io/documentation/developer-docs/latest/concepts/configurations.html#bootstrap
 */

module.exports = () => {
	RunMoralisWatcher();
};
