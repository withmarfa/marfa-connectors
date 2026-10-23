export { googleEnv } from "./env.js";
export {
  connectGoogle,
  missingScopes,
  Google,
  type Access,
  type GoogleContext,
  type GoogleNeeds,
} from "./google.js";
export {
  classify,
  GoogleError,
  toChangeError,
  type Condition,
  type GoogleErrorKind,
} from "./errors.js";
export {
  googleEndpoints,
  type GoogleEndpoints,
  type GoogleOptions,
} from "./endpoints.js";
export {
  accountCondition,
  clientCondition,
  endsCondition,
  newTokenCondition,
  reconnectCondition,
  scopeCondition,
} from "./conditions.js";
export { signIn, type GoogleSetupContext } from "./setup.js";
