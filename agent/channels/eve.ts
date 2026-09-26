import { eveChannel } from "eve/channels/eve";
import { localDev, vercelOidc } from "eve/channels/auth";
import { betterAuthEveAuth, passwordEveAuth } from "../../apps/web/lib/eve-auth";
import { withReplayAuthorization } from "../lib/replay-auth";
import { missionDispatchAuth } from "../lib/mission-auth";

export default eveChannel({
  auth: withReplayAuthorization([missionDispatchAuth, betterAuthEveAuth, passwordEveAuth, vercelOidc(), localDev()]),
  uploadPolicy: "disabled",
});
