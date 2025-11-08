"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreateTransferError = void 0;
exports.createTransfer = createTransfer;
const spl_token_1 = require("@solana/spl-token");
const web3_js_1 = require("@solana/web3.js");
const bignumber_js_1 = __importDefault(require("bignumber.js"));
const constants_js_1 = require("./constants.js");
/**
 * Thrown when a Solana Pay transfer transaction can't be created from the fields provided.
 */
class CreateTransferError extends Error {
    constructor() {
        super(...arguments);
        this.name = 'CreateTransferError';
    }
}
exports.CreateTransferError = CreateTransferError;
/**
 * Create a Solana Pay transfer transaction.
 *
 * @param connection - A connection to the cluster.
 * @param sender - Account that will send the transfer.
 * @param fields - Fields of a Solana Pay transfer request URL.
 * @param options - Options for `getLatestBlockhash`.
 *
 * @throws {CreateTransferError}
 */
function createTransfer(connection_1, sender_1, _a) {
    return __awaiter(this, arguments, void 0, function* (connection, sender, { recipient, amount, splToken, reference, memo }, { commitment } = {}) {
        // Check that the sender and recipient accounts exist
        const senderInfo = yield connection.getAccountInfo(sender);
        if (!senderInfo)
            throw new CreateTransferError('sender not found');
        const recipientInfo = yield connection.getAccountInfo(recipient);
        if (!recipientInfo)
            throw new CreateTransferError('recipient not found');
        // A native SOL or SPL token transfer instruction
        const instruction = splToken
            ? yield createSPLTokenInstruction(recipient, amount, splToken, sender, connection)
            : yield createSystemInstruction(recipient, amount, sender, connection);
        // If reference accounts are provided, add them to the transfer instruction
        if (reference) {
            if (!Array.isArray(reference)) {
                reference = [reference];
            }
            for (const pubkey of reference) {
                instruction.keys.push({ pubkey, isWritable: false, isSigner: false });
            }
        }
        // Create the transaction
        const transaction = new web3_js_1.Transaction();
        transaction.feePayer = sender;
        transaction.recentBlockhash = (yield connection.getLatestBlockhash(commitment)).blockhash;
        // If a memo is provided, add it to the transaction before adding the transfer instruction
        if (memo != null) {
            transaction.add(new web3_js_1.TransactionInstruction({
                programId: constants_js_1.MEMO_PROGRAM_ID,
                keys: [],
                data: Buffer.from(memo, 'utf8'),
            }));
        }
        // Add the transfer instruction to the transaction
        transaction.add(instruction);
        return transaction;
    });
}
function createSystemInstruction(recipient, amount, sender, connection) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        // Check that the sender and recipient accounts exist
        const senderInfo = yield connection.getAccountInfo(sender);
        if (!senderInfo)
            throw new CreateTransferError('sender not found');
        const recipientInfo = yield connection.getAccountInfo(recipient);
        if (!recipientInfo)
            throw new CreateTransferError('recipient not found');
        // Check that the sender and recipient are valid native accounts
        if (!senderInfo.owner.equals(web3_js_1.SystemProgram.programId))
            throw new CreateTransferError('sender owner invalid');
        if (senderInfo.executable)
            throw new CreateTransferError('sender executable');
        if (!recipientInfo.owner.equals(web3_js_1.SystemProgram.programId))
            throw new CreateTransferError('recipient owner invalid');
        if (recipientInfo.executable)
            throw new CreateTransferError('recipient executable');
        // Check that the amount provided doesn't have greater precision than SOL
        if (((_a = amount.decimalPlaces()) !== null && _a !== void 0 ? _a : 0) > constants_js_1.SOL_DECIMALS)
            throw new CreateTransferError('amount decimals invalid');
        // Convert input decimal amount to integer lamports
        amount = amount.times(web3_js_1.LAMPORTS_PER_SOL).integerValue(bignumber_js_1.default.ROUND_FLOOR);
        // Check that the sender has enough lamports
        const lamports = amount.toNumber();
        if (lamports > senderInfo.lamports)
            throw new CreateTransferError('insufficient funds');
        // Create an instruction to transfer native SOL
        return web3_js_1.SystemProgram.transfer({
            fromPubkey: sender,
            toPubkey: recipient,
            lamports,
        });
    });
}
function createSPLTokenInstruction(recipient, amount, splToken, sender, connection) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        // Check if token owns the Token-2022 Program
        const accountInfo = yield connection.getParsedAccountInfo(splToken);
        const accountOwner = (_a = accountInfo.value) === null || _a === void 0 ? void 0 : _a.owner;
        const tokenProgram = accountOwner && accountOwner === spl_token_1.TOKEN_2022_PROGRAM_ID ? spl_token_1.TOKEN_2022_PROGRAM_ID : spl_token_1.TOKEN_PROGRAM_ID;
        // Check that the token provided is an initialized mint
        const mint = yield (0, spl_token_1.getMint)(connection, splToken, undefined, tokenProgram);
        if (!mint.isInitialized)
            throw new CreateTransferError('mint not initialized');
        // Check that the amount provided doesn't have greater precision than the mint
        if (((_b = amount.decimalPlaces()) !== null && _b !== void 0 ? _b : 0) > mint.decimals)
            throw new CreateTransferError('amount decimals invalid');
        // Convert input decimal amount to integer tokens according to the mint decimals
        amount = amount.times(constants_js_1.TEN.pow(mint.decimals)).integerValue(bignumber_js_1.default.ROUND_FLOOR);
        // Get the sender's ATA and check that the account exists and can send tokens
        const senderATA = yield (0, spl_token_1.getAssociatedTokenAddress)(splToken, sender, undefined, tokenProgram);
        const senderAccount = yield (0, spl_token_1.getAccount)(connection, senderATA, undefined, tokenProgram);
        if (!senderAccount.isInitialized)
            throw new CreateTransferError('sender not initialized');
        if (senderAccount.isFrozen)
            throw new CreateTransferError('sender frozen');
        // Get the recipient's ATA and check that the account exists and can receive tokens
        const recipientATA = yield (0, spl_token_1.getAssociatedTokenAddress)(splToken, recipient, undefined, tokenProgram);
        const recipientAccount = yield (0, spl_token_1.getAccount)(connection, recipientATA, undefined, tokenProgram);
        if (!recipientAccount.isInitialized)
            throw new CreateTransferError('recipient not initialized');
        if (recipientAccount.isFrozen)
            throw new CreateTransferError('recipient frozen');
        // Check that the sender has enough tokens
        const tokens = BigInt(String(amount));
        if (tokens > senderAccount.amount)
            throw new CreateTransferError('insufficient funds');
        // Create an instruction to transfer SPL tokens, asserting the mint and decimals match
        return (0, spl_token_1.createTransferCheckedInstruction)(senderATA, splToken, recipientATA, sender, tokens, mint.decimals, [], tokenProgram);
    });
}
//# sourceMappingURL=createTransfer.js.map