import DataProcessor from '../../../processor';
import { ContractDBTransaction } from '../../../database';
import {EosioActionTrace, EosioContractRow, EosioTransaction} from '../../../../types/eosio';
import { ShipBlock } from '../../../../types/ship';
import {eosioTimestampToDate} from '../../../../utils/eosio';
import {
    LaunchesArgs,
    LaunchesUpdatePriority,
} from '../index';
import {
    bulkInsert,
    getAllRowsFromTable,
} from '../../../utils';
import {VestingTableRow} from '../types/tables';
import LaunchesHandler from '../index';
import ConnectionManager from '../../../../connections/manager';
import {LogClaimAction, LogNewLaunchAction, LogNewVestingAction} from '../types/actions';

const fillVestings = async (args: LaunchesArgs, connection: ConnectionManager): Promise<void> => {
    const vestingsCount = await connection.database.query(
        'SELECT COUNT(*) FROM launchbagz_vestings WHERE contract = $1',
        [args.vestings_account]
    );

    if (Number(vestingsCount.rows[0].count) === 0) {
        const vestingsTable = await getAllRowsFromTable(connection.chain.rpc, {
            json: true, code: args.vestings_account,
            scope: args.vestings_account, table: 'vestings'
        }, 1000) as VestingTableRow[];

        const dbRows = vestingsTable.map(row => getVestingDbRow(row, args, null, null));

        if (dbRows.length > 0) {
            await bulkInsert(connection.database, 'launchbagz_vestings', dbRows);
        }
    }
};

export async function initVestings(args: LaunchesArgs, connection: ConnectionManager): Promise<void> {
    if (args.vestings_account) {
        await fillVestings(args, connection);
    }
}

const newVestingListener = (core: LaunchesHandler) => async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogNewVestingAction>): Promise<void> => {
    const row = getVestingDbRow({
        ...trace.act.data,
        last_claim_time: 0,
        total_claimed: '0',
    }, core.args, block.block_num, block.timestamp);
    await db.insert('launchbagz_vestings', row, ['contract', 'vesting_id']);
};

const claimVestingListener = (core: LaunchesHandler) => async (db: ContractDBTransaction, block: ShipBlock, tx: EosioTransaction, trace: EosioActionTrace<LogClaimAction>): Promise<void> => {
    await db.update('launchbagz_vestings', {
        total_claimed: trace.act.data.new_total_claimed,
        is_active: trace.act.data.new_total_claimed !== trace.act.data.total_allocation,
        last_claim_time: eosioTimestampToDate(block.timestamp).getTime(),
    }, {
        str: 'contract = $1 AND vesting_id = $2',
        values: [core.args.vestings_account, trace.act.data.vesting_id]
    }, ['contract', 'vesting_id']);
};

const vestingsTableListener = (core: LaunchesHandler) => async (db: ContractDBTransaction, block: ShipBlock, delta: EosioContractRow<VestingTableRow>): Promise<void> => {
    const is_active = delta.present;
    if (!is_active) {
        const { rows } = await db.query('SELECT is_active FROM launchbagz_vestings WHERE contract = $1 AND vesting_id = $2', [core.args.vestings_account, delta.value.vesting_id]);
        if (rows.length > 0 && rows[0].is_active) {
            await db.update('launchbagz_vestings', {
                is_active,
            }, {
                str: 'contract = $1 AND vesting_id = $2',
                values: [core.args.vestings_account, delta.value.vesting_id]
            }, ['contract', 'vesting_id']);
        }
    }
};

function getVestingDbRow(vesting: VestingTableRow, args: LaunchesArgs, blockNumber: number, blockTimeStamp: string): any {
    const [precision, tokenCode] = vesting.token.sym.split(',');
    const tokenContract = vesting.token.contract;
    return {
        contract: args.vestings_account,
        vesting_id: vesting.vesting_id,
        recipient: vesting.recipient,
        owner: vesting.owner,
        token_contract: tokenContract,
        token_code: tokenCode,
        token_precision: +precision,
        start_time: vesting.start_time * 1000,
        last_claim_time: vesting.last_claim_time * 1000,
        total_claimed: vesting.total_claimed,
        immediate_unlock: vesting.immediate_unlock,
        total_allocation: vesting.total_allocation,
        period_length: vesting.period_length * 1000,
        total_periods: vesting.total_periods,
        description: vesting.description,
        is_active: true,
        updated_at_block: blockNumber || 0,
        updated_at_time: blockTimeStamp ? eosioTimestampToDate(blockTimeStamp).getTime() : 0,
        created_at_block: blockNumber || 0,
        created_at_time: blockTimeStamp ? eosioTimestampToDate(blockTimeStamp).getTime() : 0
    };
}

export function vestingsProcessor(core: LaunchesHandler, processor: DataProcessor): () => any {
    const destructors: Array<() => any> = [];
    const contract = core.args.vestings_account;

    if (contract) {
        destructors.push(processor.onContractRow(
            contract, 'vestings',
            vestingsTableListener(core),
            LaunchesUpdatePriority.TABLE_VESTINGS.valueOf()
        ));

        destructors.push(processor.onActionTrace(
            contract, 'lognewvesting',
            newVestingListener(core),
            LaunchesUpdatePriority.LOG_NEW_VESTING.valueOf()
        ));

        destructors.push(processor.onActionTrace(
            contract, 'logclaim',
            claimVestingListener(core),
            LaunchesUpdatePriority.LOG_CLAIM_VESTING.valueOf()
        ));
    }

    return (): any => destructors.map(fn => fn());
}
