import * as Domain from "@alchemy.run/domain";
import { Console } from "./Console.model.ts";

/**
 * HighAlch Console's one Api, for browsers (over WebSocket) and CI (over HTTP): the queries
 * behind every row a page shows, the organisation feed that keeps them live, the commands a
 * user or an upload credential sends (each names its target in its input), and the signed
 * links bodies travel through. Every call runs the `Caller` middleware (a session,
 * an API key or a GitHub OIDC token; `CallerLive`), except the public `Catalog`. Each command,
 * query and the feed authorises itself.
 */
export class ConsoleApi extends Domain.Api(
  "ConsoleApi",
  {
    model: Console,
    commands: [
      "CreateOrganization",
      "CreateProject",
      "ClaimRepository",
      "ReleaseRepository",
      "BindRepository",
      "IssueApiKey",
      "RevokeApiKey",
      "OpenRun",
      "DeclareArtifacts",
      "RecordResults",
      "RecordStory",
      "CompleteRun",
    ],
    views: [],
    streams: ["OrganizationChanges"],
    queries: [
      "Me",
      "Catalog",
      "OrganizationById",
      "Members",
      "Billing",
      "Projects",
      "ApiKeys",
      "Commits",
      "Pulls",
      "Runs",
      "RunById",
      "ResultParts",
      "Artifacts",
      "Subjects",
      "SubjectHistory",
      "Stories",
      "UploadLinks",
      "ArtifactLinks",
      "ResultPartLinks",
      "Credential",
      "CheckoutLink",
      "PortalLink",
    ],
  },
  { description: "HighAlch Console: its rows, their feed and its commands." },
) {}

/**
 * Everything the model serves, for the server's own trusted code in process (payment webhooks):
 * every command, and the organisation of a Stripe customer. Its
 * `Caller` is a fixed `System` actor. Never served over the network.
 */
export class ConsoleSystemApi extends Domain.Api(
  "ConsoleSystemApi",
  { model: Console, views: ["CustomerOrganization"], streams: [], queries: [] },
  { description: "HighAlch Console's trusted in-process interface for the server." },
) {}
