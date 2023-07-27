import { Uid2ApiClient } from "./uid2ApiClient";
import {
  EventType,
  Uid2CallbackHandler,
  Uid2CallbackManager,
} from "./uid2CallbackManager";
import { UID2CookieManager } from "./uid2CookieManager";
import { Uid2Identity } from "./Uid2Identity";
import { IdentityStatus, notifyInitCallback } from "./Uid2InitCallbacks";
import { isUID2OptionsOrThrow, Uid2Options } from "./Uid2Options";
import { UID2PromiseHandler } from "./uid2PromiseHandler";
import { version } from "../package.json";
import { isBase64Hash } from "./uid2HashedDii";
import { isNormalizedPhone, normalizeEmail } from "./uid2DiiNormalization";

function hasExpired(expiry: number, now = Date.now()) {
  return expiry <= now;
}

let postUid2CreateCallback: null | (() => void) = null;

type LoginOptionsCommon = {
  readonly serverPublicKey: string;
  readonly subscriptionId: string;
};

type EmailLoginOptions = {
  readonly email: string;
};

type EmailHashLoginOptions = {
  readonly emailHash: string;
};

type PhoneLoginOptions = {
  readonly phone: string;
};

type PhoneHashLoginOptions = {
  readonly phoneHash: string;
};

export type LoginOptions = LoginOptionsCommon &
  (
    | EmailLoginOptions
    | EmailHashLoginOptions
    | PhoneLoginOptions
    | PhoneHashLoginOptions
  );

export class UID2 {
  static get VERSION() {
    return version;
  }
  static get COOKIE_NAME() {
    return "__uid_2";
  }
  static get DEFAULT_REFRESH_RETRY_PERIOD_MS() {
    return 5000;
  }
  static IdentityStatus = IdentityStatus;
  static EventType = EventType;

  static setupGoogleTag() {
    UID2.setupGoogleSecureSignals();
  }

  static setupGoogleSecureSignals() {
    if (window.__uid2SecureSignalProvider)
      window.__uid2SecureSignalProvider.registerSecureSignalProvider();
  }

  // Push functions to this array to receive event notifications
  public callbacks: Uid2CallbackHandler[] = [];

  // Dependencies initialised on construction
  private _tokenPromiseHandler: UID2PromiseHandler;
  private _callbackManager: Uid2CallbackManager;

  // Dependencies initialised on call to init due to requirement for options
  private _cookieManager: UID2CookieManager | undefined;
  private _apiClient: Uid2ApiClient | undefined;

  // State
  private _opts: Uid2Options = {};
  private _identity: Uid2Identity | null | undefined;
  private _initComplete = false;

  constructor(
    existingCallbacks: Uid2CallbackHandler[] | undefined = undefined
  ) {
    if (existingCallbacks) this.callbacks = existingCallbacks;

    this._tokenPromiseHandler = new UID2PromiseHandler(this);
    this._callbackManager = new Uid2CallbackManager(this, () =>
      this.getIdentity()
    );
    const runCallbacks = () => {
      this._callbackManager.runCallbacks(EventType.SdkLoaded, {});
    };
    if (window.__uid2 instanceof UID2) {
      runCallbacks();
    } else {
      // Need to defer running callbacks until this is assigned to the window global
      postUid2CreateCallback = runCallbacks;
    }
  }

  public init(opts: Uid2Options) {
    this.initInternal(opts);
  }

  public getAdvertisingToken() {
    return this.getIdentity()?.advertising_token ?? undefined;
  }

  public login(opts: LoginOptions) {
    this.loginInternal(opts);
  }

  public setIdentity(identity: Uid2Identity) {
    if (this._apiClient) this._apiClient.abortActiveRequests();
    const validatedIdentity = this.validateAndSetIdentity(identity);
    if (validatedIdentity) {
      this.triggerRefreshOrSetTimer(validatedIdentity);
      this._callbackManager.runCallbacks(EventType.IdentityUpdated, {});
    }
  }

  public getIdentity(): Uid2Identity | null {
    return this._identity && !this.temporarilyUnavailable()
      ? this._identity
      : null;
  }
  // When the SDK has been initialized, this function should return the token
  // from the most recent refresh request, if there is a request, wait for the
  // new token. Otherwise, returns a promise which will be resolved after init.
  public getAdvertisingTokenAsync() {
    const token = this.getAdvertisingToken();
    return this._tokenPromiseHandler.createMaybeDeferredPromise(token ?? null);
  }

  public isLoginRequired() {
    if (!this._initComplete) return undefined;
    return !(this.isLoggedIn() || this._apiClient?.hasActiveRequests());
  }

  public disconnect() {
    this.abort(`UID2 SDK disconnected.`);
    // Note: This silently fails to clear the cookie if init hasn't been called and a cookieDomain is used!
    if (this._cookieManager) this._cookieManager.removeCookie();
    else new UID2CookieManager({}).removeCookie();
    this._identity = undefined;
    this._callbackManager.runCallbacks(UID2.EventType.IdentityUpdated, {
      identity: null,
    });
  }

  // Note: This doesn't invoke callbacks. It's a hard, silent reset.
  public abort(reason?: string) {
    this._initComplete = true;
    this._tokenPromiseHandler.rejectAllPromises(
      reason ?? new Error(`UID2 SDK aborted.`)
    );
    if (this._refreshTimerId) {
      clearTimeout(this._refreshTimerId);
      this._refreshTimerId = null;
    }
    if (this._apiClient) this._apiClient.abortActiveRequests();
  }

  private static isEmailLoginOptions(value: any): value is EmailLoginOptions {
    return "email" in value;
  }

  private static isEmailHashLoginOptions(
    value: any
  ): value is EmailHashLoginOptions {
    return "emailHash" in value;
  }

  private static isPhoneLoginOptions(value: any): value is PhoneLoginOptions {
    return "phone" in value;
  }

  private static isPhoneHashLoginOptions(
    value: any
  ): value is PhoneHashLoginOptions {
    return "phoneHash" in value;
  }

  private static validateAndNormalize(
    dii:
      | EmailLoginOptions
      | EmailHashLoginOptions
      | PhoneLoginOptions
      | PhoneHashLoginOptions
  ) {
    if (this.isEmailHashLoginOptions(dii)) {
      return isBase64Hash(dii.emailHash) ? dii : undefined;
    }

    if (this.isPhoneHashLoginOptions(dii)) {
      return isBase64Hash(dii.phoneHash) ? dii : undefined;
    }

    if (this.isEmailLoginOptions(dii)) {
      const normalizedEmail = normalizeEmail(dii.email);
      return normalizedEmail ? { email: normalizedEmail } : undefined;
    }

    if (this.isPhoneLoginOptions(dii)) {
      return isNormalizedPhone(dii.phone) ? dii : undefined;
    }
  }

  // TODO: See if this is already implemented elsewhere.
  private static bytesToBase64(bytes: Uint8Array): string {
    const binString = Array.from(bytes, (x) => String.fromCodePoint(x)).join(
      ""
    );
    return btoa(binString);
  }

  private static async hash(value: string) {
    const hash = await window.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value)
    );
    return UID2.bytesToBase64(new Uint8Array(hash));
  }

  private static async hashDii(
    dii:
      | EmailLoginOptions
      | EmailHashLoginOptions
      | PhoneLoginOptions
      | PhoneHashLoginOptions
  ) {
    if (
      this.isEmailHashLoginOptions(dii) ||
      this.isPhoneHashLoginOptions(dii)
    ) {
      return dii;
    }

    if (this.isEmailLoginOptions(dii)) {
      return { emailHash: await UID2.hash(dii.email) };
    }

    if (this.isPhoneLoginOptions(dii)) {
      return { phoneHash: await UID2.hash(dii.phone) };
    }

    throw new Error("invalid DII");
  }

  private initInternal(opts: Uid2Options | unknown) {
    if (this._initComplete) {
      throw new TypeError("Calling init() more than once is not allowed");
    }
    if (!isUID2OptionsOrThrow(opts))
      throw new TypeError(
        `Options provided to UID2 init couldn't be validated.`
      );

    this._opts = opts;
    this._cookieManager = new UID2CookieManager({ ...opts });
    this._apiClient = new Uid2ApiClient(opts);
    this._tokenPromiseHandler.registerApiClient(this._apiClient);
    const identity = this._opts.identity
      ? this._opts.identity
      : this._cookieManager.loadIdentityFromCookie();
    const validatedIdentity = this.validateAndSetIdentity(identity);
    if (validatedIdentity) this.triggerRefreshOrSetTimer(validatedIdentity);
    this._initComplete = true;
    this._callbackManager?.runCallbacks(EventType.InitCompleted, {});
  }

  private async loginInternal(opts: LoginOptions): Promise<void> {
    if (!this._initComplete) {
      throw new Error("Cannot login before calling init.");
    }

    const validatedNormalizedInput = UID2.validateAndNormalize(opts);
    if (!validatedNormalizedInput) {
      // TODO: Better error message.
      throw new Error("Invalid DII");
    }

    const identity = await this._apiClient!.callCstgApi(
      await UID2.hashDii(validatedNormalizedInput),
      opts.subscriptionId,
      opts.serverPublicKey
    );

    this.setIdentity(identity.identity);
  }

  private isLoggedIn() {
    return this._identity && !hasExpired(this._identity.refresh_expires);
  }

  private temporarilyUnavailable() {
    if (!this._identity && this._apiClient?.hasActiveRequests()) return true;
    if (
      this._identity &&
      hasExpired(this._identity.identity_expires) &&
      !hasExpired(this._identity.refresh_expires)
    )
      return true;
    return false;
  }

  private getIdentityStatus(identity: Uid2Identity | null):
    | {
        valid: true;
        identity: Uid2Identity;
        errorMessage: string;
        status: IdentityStatus;
      }
    | {
        valid: false;
        errorMessage: string;
        status: IdentityStatus;
        identity: null;
      } {
    if (!identity) {
      return {
        valid: false,
        errorMessage: "Identity not available",
        status: UID2.IdentityStatus.NO_IDENTITY,
        identity: null,
      };
    }
    if (!identity.advertising_token) {
      return {
        valid: false,
        errorMessage: "advertising_token is not available or is not valid",
        status: IdentityStatus.INVALID,
        identity: null,
      };
    }
    if (!identity.refresh_token) {
      return {
        valid: false,
        errorMessage: "refresh_token is not available or is not valid",
        status: IdentityStatus.INVALID,
        identity: null,
      };
    }
    if (hasExpired(identity.refresh_expires, Date.now())) {
      return {
        valid: false,
        errorMessage: "Identity expired, refresh expired",
        status: IdentityStatus.REFRESH_EXPIRED,
        identity: null,
      };
    }
    if (hasExpired(identity.identity_expires, Date.now())) {
      return {
        valid: true,
        errorMessage: "Identity expired, refresh still valid",
        status: IdentityStatus.EXPIRED,
        identity,
      };
    }
    if (typeof this._identity === "undefined")
      return {
        valid: true,
        identity,
        status: IdentityStatus.ESTABLISHED,
        errorMessage: "Identity established",
      };
    return {
      valid: true,
      identity,
      status: IdentityStatus.REFRESHED,
      errorMessage: "Identity refreshed",
    };
  }

  private validateAndSetIdentity(
    identity: Uid2Identity | null,
    status?: IdentityStatus,
    statusText?: string
  ): Uid2Identity | null {
    if (!this._cookieManager)
      throw new Error("Cannot set identity before calling init.");
    const validity = this.getIdentityStatus(identity);
    if (
      validity.identity &&
      validity.identity?.advertising_token === this._identity?.advertising_token
    )
      return validity.identity;

    this._identity = validity.identity;
    if (validity.identity) {
      this._cookieManager.setCookie(validity.identity);
    } else {
      this.abort();
      this._cookieManager.removeCookie();
    }
    notifyInitCallback(
      this._opts,
      status ?? validity.status,
      statusText ?? validity.errorMessage,
      this.getAdvertisingToken()
    );
    return validity.identity;
  }

  private triggerRefreshOrSetTimer(validIdentity: Uid2Identity) {
    if (hasExpired(validIdentity.refresh_from, Date.now())) {
      this.refreshToken(validIdentity);
    } else {
      this.setRefreshTimer();
    }
  }

  private _refreshTimerId: ReturnType<typeof setTimeout> | null = null;

  private setRefreshTimer() {
    const timeout =
      this._opts?.refreshRetryPeriod ?? UID2.DEFAULT_REFRESH_RETRY_PERIOD_MS;
    if (this._refreshTimerId) {
      clearTimeout(this._refreshTimerId);
    }
    this._refreshTimerId = setTimeout(() => {
      if (this.isLoginRequired()) return;
      const validatedIdentity = this.validateAndSetIdentity(
        this._cookieManager?.loadIdentityFromCookie() ?? null
      );
      if (validatedIdentity) this.triggerRefreshOrSetTimer(validatedIdentity);
      this._refreshTimerId = null;
    }, timeout);
  }

  private refreshToken(identity: Uid2Identity) {
    const apiClient = this._apiClient;
    if (!apiClient)
      throw new Error("Cannot refresh the token before calling init.");

    apiClient
      .callRefreshApi(identity)
      .then(
        (response) => {
          switch (response.status) {
            case "success":
              this.validateAndSetIdentity(
                response.identity,
                IdentityStatus.REFRESHED,
                "Identity refreshed"
              );
              this.setRefreshTimer();
              break;
            case "optout":
              this.validateAndSetIdentity(
                null,
                IdentityStatus.OPTOUT,
                "User opted out"
              );
              break;
            case "expired_token":
              this.validateAndSetIdentity(
                null,
                IdentityStatus.REFRESH_EXPIRED,
                "Refresh token expired"
              );
              break;
          }
        },
        (reason) => {
          console.warn(
            `Encountered an error refreshing the UID2 token`,
            reason
          );
          this.validateAndSetIdentity(identity);
          if (!hasExpired(identity.refresh_expires, Date.now()))
            this.setRefreshTimer();
        }
      )
      .then(
        () => {
          this._callbackManager.runCallbacks(EventType.IdentityUpdated, {});
        },
        (reason) =>
          console.warn(`UID2 callbacks on identity event failed.`, reason)
      );
  }
}

type UID2Setup = {
  callbacks: Uid2CallbackHandler[] | undefined;
};
declare global {
  interface Window {
    __uid2: UID2 | UID2Setup | undefined;
  }
}

export function __uid2InternalHandleScriptLoad() {
  const callbacks = window?.__uid2?.callbacks || [];
  window.__uid2 = new UID2(callbacks);
  if (postUid2CreateCallback) postUid2CreateCallback();
}
__uid2InternalHandleScriptLoad();

export const sdkWindow = globalThis.window;
