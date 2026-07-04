import { SetMetadata } from "@nestjs/common";

export const REQUIRE_KEY_TYPE_METADATA_KEY = "requireKeyType";

export const RequireKeyType = (keyType: "secret") => SetMetadata(REQUIRE_KEY_TYPE_METADATA_KEY, keyType);
