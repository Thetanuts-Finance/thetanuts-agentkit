// Required by AgentKit's @CreateAction decorator (uses
// Reflect.getMetadata at runtime). Imported once at the package entry so
// consumers don't have to remember.
import 'reflect-metadata';

export {
  ThetanutsActionProvider,
  thetanutsActionProvider,
} from './thetanutsActionProvider.js';

export {
  ApproveSchema,
  RequestRfqSchema,
  MakeOfferSchema,
  SettleRfqSchema,
  SettleRfqEarlySchema,
  CancelRfqSchema,
  CancelOfferSchema,
  TransferPositionSchema,
  GetUserPositionsSchema,
  GetRfqSchema,
  ProductEnum,
  UnderlyingEnum,
  CollateralEnum,
} from './schemas.js';

export type {
  ApproveArgs,
  RequestRfqArgs,
  MakeOfferArgs,
  SettleRfqArgs,
  SettleRfqEarlyArgs,
  CancelRfqArgs,
  CancelOfferArgs,
  TransferPositionArgs,
  GetUserPositionsArgs,
  GetRfqArgs,
} from './schemas.js';

export { BASE_CHAIN_ID, safeGetAddress } from './sdk.js';

export { SafetyPolicy, isSafetyError } from './safety.js';
export type { SafetyLimits, SafetyContext, SafetyActionType } from './safety.js';
