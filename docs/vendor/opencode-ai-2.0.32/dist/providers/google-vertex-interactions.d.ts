import type { ProviderPackage } from "../provider-package.js";
import { GoogleInteractions } from "../protocols/google-interactions.js";
import { Route, type RouteDefaultsInput } from "../route/client.js";
import { type ModelID } from "../schema/index.js";
import { GoogleVertexShared } from "./google-vertex-shared.js";
export type GoogleInteractionsOptionsInput = GoogleInteractions.OptionsInput;
export declare const id: string & import("effect/Brand").Brand<"AI.ProviderID">;
export type Config = RouteDefaultsInput & GoogleVertexShared.ApiKeyOptions & {
    readonly baseURL?: string;
    readonly location?: string;
    readonly project?: string;
    readonly providerOptions?: GoogleInteractions.ProviderOptionsInput;
};
export type Settings = ProviderPackage.Settings & GoogleInteractions.ProviderOptionsInput & ({
    readonly accessToken?: string;
    readonly apiKey?: never;
} | {
    readonly accessToken?: never;
    readonly apiKey?: string;
}) & {
    readonly baseURL?: string;
    readonly location?: string;
    readonly project?: string;
};
export declare const routes: Route<{
    readonly input: readonly ({
        readonly type: "user_input" | "model_output";
        readonly content: readonly ({
            readonly type: "text";
            readonly text: string;
        } | {
            readonly type: "image" | "document" | "video" | "audio";
            readonly mime_type: string;
            readonly data?: string | undefined;
            readonly uri?: string | undefined;
        })[];
    } | {
        readonly type: "thought";
        readonly summary?: readonly {
            readonly type: "text";
            readonly text: string;
        }[] | undefined;
        readonly signature?: string | undefined;
    } | {
        readonly id: string;
        readonly type: "function_call";
        readonly name: string;
        readonly arguments: unknown;
        readonly signature?: string | undefined;
    } | {
        readonly type: "function_result";
        readonly name: string;
        readonly result: unknown;
        readonly call_id: string;
        readonly is_error?: boolean | undefined;
    })[];
    readonly model: string;
    readonly stream: true;
    readonly store: boolean;
    readonly generation_config: {
        readonly temperature?: number | undefined;
        readonly seed?: number | undefined;
        readonly tool_choice?: "auto" | "none" | "any" | {
            readonly allowed_tools: {
                readonly mode: "any";
                readonly tools: readonly string[];
            };
        } | undefined;
        readonly top_p?: number | undefined;
        readonly stop_sequences?: readonly string[] | undefined;
        readonly max_output_tokens?: number | undefined;
        readonly thinking_level?: import("../schema/options.js").OpenString<"minimal" | "low" | "medium" | "high"> | undefined;
        readonly thinking_summaries?: string | undefined;
    };
    readonly tools?: readonly {
        readonly type: "function";
        readonly name: string;
        readonly description: string;
        readonly parameters: {
            readonly [x: string]: unknown;
        };
    }[] | undefined;
    readonly service_tier?: string | undefined;
    readonly previous_interaction_id?: string | undefined;
    readonly system_instruction?: string | undefined;
}, import("../route/transport/http.js").HttpPrepared<string>, import("../route/client.js").CompactionOperations | undefined>[];
export declare const configure: (input?: Config) => {
    id: string & import("effect/Brand").Brand<"AI.ProviderID">;
    model: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<{
        readonly serviceTier?: import("../schema/options.js").OpenString<"standard" | "flex" | "priority" | "deferred"> | undefined;
        readonly thinkingLevel?: import("../schema/options.js").OpenString<"minimal" | "low" | "medium" | "high"> | undefined;
        readonly previousInteractionId?: string | undefined;
        readonly store?: boolean | undefined;
        readonly thinkingSummaries?: import("../schema/options.js").OpenString<"auto" | "none"> | undefined;
    }, import("../route/client.js").CompactionOperations | undefined>;
    configure: (input?: Config) => /*elided*/ any;
};
export declare const provider: {
    id: string & import("effect/Brand").Brand<"AI.ProviderID">;
    configure: (input?: Config) => {
        id: string & import("effect/Brand").Brand<"AI.ProviderID">;
        model: (modelID: string | ModelID) => import("../schema/options.js").LanguageModel<{
            readonly serviceTier?: import("../schema/options.js").OpenString<"standard" | "flex" | "priority" | "deferred"> | undefined;
            readonly thinkingLevel?: import("../schema/options.js").OpenString<"minimal" | "low" | "medium" | "high"> | undefined;
            readonly previousInteractionId?: string | undefined;
            readonly store?: boolean | undefined;
            readonly thinkingSummaries?: import("../schema/options.js").OpenString<"auto" | "none"> | undefined;
        }, import("../route/client.js").CompactionOperations | undefined>;
        configure: /*elided*/ any;
    };
};
export declare const model: ProviderPackage.Definition<Settings, GoogleInteractions.ProviderOptionsInput>["model"];
