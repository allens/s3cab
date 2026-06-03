import {
  GetRoleCredentialsCommand,
  ListAccountRolesCommand,
  ListAccountsCommand,
  SSOClient,
} from "@aws-sdk/client-sso";
import {
  CreateTokenCommand,
  RegisterClientCommand,
  SSOOIDCClient,
  StartDeviceAuthorizationCommand,
} from "@aws-sdk/client-sso-oidc";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";

export const loginCommand = {
  name: "login",
  summary: "AWS SSO Login",
  exec: async () => login(),
};

async function login() {
  // TODO: get startUrl from profile
  const startUrl = "https://thehousecat.awsapps.com/start";

  const ssoOidcClient = new SSOOIDCClient({ region: "eu-west-1" });
  const ssoClient = new SSOClient({ region: "eu-west-1" });

  const { clientId, clientSecret } = await ssoOidcClient.send(
    new RegisterClientCommand({
      clientName: "s3cab",
      clientType: "public",
      scopes: ["sso:account:access"],
    }),
  );

  const { deviceCode, verificationUriComplete, userCode } =
    await ssoOidcClient.send(
      new StartDeviceAuthorizationCommand({
        clientId,
        clientSecret,
        startUrl,
      }),
    );

  const rl = readline.createInterface({ input, output });

  await rl.question(`Attempting to automatically open the SSO authorization page in your default browser.
  If the browser does not open or you wish to use a different device to authorize this request, open the following URL:
  
  ${verificationUriComplete}
  
  Then enter the code:
  
  ${userCode}
  
  Then press Enter to continue when you see the "s3cab can now access your data" message.`);

  console.log(`Successfully logged into Start URL: ${startUrl}`);

  rl.close();

  const { accessToken } = await ssoOidcClient.send(
    new CreateTokenCommand({
      clientId,
      clientSecret,
      deviceCode,
      grantType: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  );

  const { accountList } = await ssoClient.send(
    new ListAccountsCommand({ accessToken }),
  );

  const { accountId } = accountList[0];

  const { roleList } = await ssoClient.send(
    new ListAccountRolesCommand({ accessToken, accountId }),
  );

  const { roleName } = roleList[0];

  const { roleCredentials } = await ssoClient.send(
    new GetRoleCredentialsCommand({
      accessToken,
      accountId,
      roleName,
    }),
  );

  console.log(roleCredentials);
}
