import { Injectable } from "@nestjs/common";
import { SiweMessage } from "siwe";
import { AppException } from "../common/errors.js";
import { NonceStore } from "./nonce.store.js";

@Injectable()
export class AuthService {
  constructor(private readonly nonceStore: NonceStore) {}

  issueNonce(): string {
    return this.nonceStore.issue();
  }

  async verify(message: string, signature: string): Promise<{ address: string }> {
    let siweMessage: SiweMessage;
    try {
      siweMessage = new SiweMessage(message);
    } catch {
      throw new AppException({
        type: "invalid_request_error",
        code: "invalid_siwe_message",
        message: "The SIWE message could not be parsed.",
        param: "message",
      });
    }

    if (!this.nonceStore.consume(siweMessage.nonce)) {
      throw new AppException({
        type: "authentication_error",
        code: "invalid_nonce",
        message: "The nonce is missing, expired, or already used.",
      });
    }

    // `suppressExceptions: true` is required: siwe's default behavior is to
    // *reject* the promise with the failure result (not resolve it) on any
    // verification failure, which would otherwise bypass the `!result.success`
    // check below and surface as an unhandled 500 instead of a 401.
    const result = await siweMessage.verify({ signature }, { suppressExceptions: true });
    if (!result.success) {
      throw new AppException({
        type: "authentication_error",
        code: "invalid_signature",
        message: result.error?.type ?? "Signature verification failed.",
      });
    }

    return { address: siweMessage.address };
  }
}
