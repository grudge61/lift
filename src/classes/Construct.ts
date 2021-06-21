import { PolicyStatement } from "../CloudFormation";
import { AwsProvider } from "./AwsProvider";

/**
 * Defines which methods a Lift construct must expose.
 */
export interface ConstructInterface {
    outputs(): Record<string, () => Promise<string | undefined>>;

    commands(): Record<string, () => void | Promise<void>>;

    /**
     * CloudFormation references
     */
    references(): Record<string, Record<string, unknown>>;

    /**
     * Post-CloudFormation deployment
     */
    postDeploy?(): Promise<void>;

    /**
     * Pre-CloudFormation deletion
     */
    preRemove?(): Promise<void>;

    /**
     * IAM permissions to add to Lambda functions of the stack
     */
    permissions?(): PolicyStatement[];
}

/**
 * Defines which static properties and methods a Lift construct must expose.
 */
export interface StaticConstructInterface {
    type: string;
    schema: {
        type: "object";
        [k: string]: unknown;
    };
    create(provider: AwsProvider, id: string, configuration: Record<string, unknown>): ConstructInterface;
}
