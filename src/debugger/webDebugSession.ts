// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import { logger } from "vscode-debugadapter";
import { DebugProtocol } from "vscode-debugprotocol";
import * as nls from "vscode-nls";
import { TelemetryHelper } from "../common/telemetryHelper";
import { RnCDPMessageHandler } from "../cdp-proxy/CDPMessageHandlers/rnCDPMessageHandler";
import { ErrorHelper } from "../common/error/errorHelper";
import { InternalErrorCode } from "../common/error/internalErrorCode";
import { ReactNativeCDPProxy } from "../cdp-proxy/reactNativeCDPProxy";
import { Request } from "../common/node/request";
import { PromiseUtil } from "../common/node/promise";
import { MultipleLifetimesAppWorker } from "./appWorker";
import {
    DebugSessionBase,
    DebugSessionStatus,
    IAttachRequestArgs,
    ILaunchRequestArgs,
} from "./debugSessionBase";
import { JsDebugConfigAdapter } from "./jsDebugConfigAdapter";
import { RNSession } from "./debugSessionWrapper";

nls.config({
    messageFormat: nls.MessageFormat.bundle,
    bundleFormat: nls.BundleFormat.standalone,
})();
const localize = nls.loadMessageBundle();

export class WebDebugSession extends DebugSessionBase {
    private appWorker: MultipleLifetimesAppWorker | null;
    private onDidStartDebugSessionHandler: vscode.Disposable;
    private onDidTerminateDebugSessionHandler: vscode.Disposable;
    private cdpProxy: ReactNativeCDPProxy;
    private readonly pwaSessionName: string = "pwa-chrome";
    private cdpProxyErrorHandlerDescriptor?: vscode.Disposable;
    private attachRetryCount: number = 2;

    constructor(rnSession: RNSession) {
        super(rnSession);

        // variables definition
        this.appWorker = null;

        this.onDidStartDebugSessionHandler = vscode.debug.onDidStartDebugSession(
            this.handleStartDebugSession.bind(this),
        );

        this.onDidTerminateDebugSessionHandler = vscode.debug.onDidTerminateDebugSession(
            this.handleTerminateDebugSession.bind(this),
        );
    }

    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        launchArgs: ILaunchRequestArgs,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        request?: DebugProtocol.Request,
    ): Promise<void> {
        try {
            try {
                await this.initializeSettings(launchArgs);
                logger.log("Launching the application");
                logger.verbose(`Launching the application: ${JSON.stringify(launchArgs, null, 2)}`);

                await this.verifyExpoWebRequiredDependencies(launchArgs);
                await this.appLauncher.launchExpoWeb(launchArgs);
                await this.waitExpoWebIsRunning(launchArgs);
                await this.appLauncher.launchBrowser(launchArgs);
            } catch (error) {
                throw ErrorHelper.getInternalError(
                    InternalErrorCode.ApplicationLaunchFailed,
                    error.message || error,
                );
            }
            // if debugging is enabled start attach request
            await this.vsCodeDebugSession.customRequest("attach", launchArgs);
            this.sendResponse(response);
        } catch (error) {
            this.terminateWithErrorResponse(error, response);
        }
    }

    protected async attachRequest(
        response: DebugProtocol.AttachResponse,
        attachArgs: IAttachRequestArgs,
        request?: DebugProtocol.Request,
    ): Promise<void> {
        const doAttach = async (attachArgs: IAttachRequestArgs) => {
            try {
                await this.initializeSettings(attachArgs);
                attachArgs.port = attachArgs.port || 9222;

                await TelemetryHelper.generate("attach", attachArgs, async generator => {
                    generator.add("platform", attachArgs.platform, false);
                    generator.add("browser", attachArgs.browserTarget, false);

                    this.cdpProxy = this.appLauncher.getRnCdpProxy();
                    this.cdpProxy.setApplicationTargetPort(attachArgs.port);
                    await this.cdpProxy.initializeServer(
                        new RnCDPMessageHandler(),
                        this.cdpProxyLogLevel,
                        this.cancellationTokenSource.token,
                    );

                    logger.log(localize("AttachingToApp", "Attaching to app"));
                    const processedAttachArgs = Object.assign({}, attachArgs, {});
                    if (processedAttachArgs.webSocketDebuggerUrl) {
                        this.cdpProxy.setBrowserInspectUri(
                            processedAttachArgs.webSocketDebuggerUrl,
                        );
                    }
                    this.cdpProxyErrorHandlerDescriptor = this.cdpProxy.onError(
                        async (err: Error) => {
                            if (this.attachRetryCount > 0) {
                                this.debugSessionStatus = DebugSessionStatus.ConnectionPending;
                                this.attachRetryCount--;
                                void doAttach(attachArgs);
                            } else {
                                this.showError(err);
                                void this.terminate();
                                this.cdpProxyErrorHandlerDescriptor?.dispose();
                            }
                        },
                    );
                    await this.establishDebugSession(processedAttachArgs);

                    this.debugSessionStatus = DebugSessionStatus.ConnectionDone;
                });
            } catch (error) {
                this.debugSessionStatus = DebugSessionStatus.ConnectionFailed;
                throw error;
            }
        };

        try {
            await doAttach(attachArgs);
            this.sendResponse(response);
        } catch (error) {
            this.terminateWithErrorResponse(error, response);
        }
    }

    protected async disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments,
        request?: DebugProtocol.Request,
    ): Promise<void> {
        // The client is about to disconnect so first we need to stop app worker
        if (this.appWorker) {
            this.appWorker.stop();
        }

        this.onDidStartDebugSessionHandler.dispose();
        this.onDidTerminateDebugSessionHandler.dispose();

        return super.disconnectRequest(response, args, request);
    }

    protected establishDebugSession(
        attachArgs: IAttachRequestArgs,
        resolve?: (value?: void | PromiseLike<void> | undefined) => void,
    ): void {
        if (this.cdpProxy) {
            const attachArguments = JsDebugConfigAdapter.createChromeDebuggingConfig(
                attachArgs,
                this.appLauncher.getCdpProxyPort(),
                this.pwaSessionName,
                this.rnSession.sessionId,
            );

            const childDebugSessionStarted = vscode.debug.startDebugging(
                this.appLauncher.getWorkspaceFolder(),
                attachArguments,
                {
                    parentSession: this.vsCodeDebugSession,
                    consoleMode: vscode.DebugConsoleMode.MergeWithParent,
                },
            );
            if (!childDebugSessionStarted) {
                const error = localize(
                    "FailedToStartDebugSession",
                    "Cannot start child debug session",
                );
                throw new Error(error);
            }
        } else {
            const error = localize("NoReactNativeCdpProxy", "Cannot get react native cdp proxy");
            throw new Error(error);
        }
    }

    private handleStartDebugSession(debugSession: vscode.DebugSession): void {
        if (
            debugSession.configuration.rnDebugSessionId === this.rnSession.sessionId &&
            debugSession.type === this.pwaNodeSessionName
        ) {
            this.nodeSession = debugSession;
        }
    }

    private handleTerminateDebugSession(debugSession: vscode.DebugSession): void {
        if (
            debugSession.configuration.rnDebugSessionId === this.rnSession.sessionId &&
            debugSession.type === this.pwaNodeSessionName
        ) {
            if (this.debugSessionStatus === DebugSessionStatus.ConnectionPending) {
                this.establishDebugSession(this.previousAttachArgs);
            } else {
                void this.terminate();
            }
        }
    }

    private verifyExpoWebRequiredDependencies(launchArgs: any): void {
        logger.log("Checking expo web required dependencies");
        const nodeModulePath = path.join(launchArgs.cwd, "node_modules");
        const expoMetroConfigPath = path.join(nodeModulePath, "@expo", "metro-config");
        const reactDomPath = path.join(nodeModulePath, "react-dom");
        const reactNativeWebPath = path.join(nodeModulePath, "react-native-web");
        if (
            fs.existsSync(expoMetroConfigPath) &&
            fs.existsSync(reactDomPath) &&
            fs.existsSync(reactNativeWebPath)
        ) {
            logger.log("All required dependencies installed");
        } else {
            logger.log(
                "Please install react-native-web@~0.19.6, react-dom@18.2.0, @expo/webpack-config by running: npx expo install react-native-web@~0.19.6 react-dom@18.2.0 @expo/webpack-config",
            );
            throw new Error(
                "Required dependencies not found: Please check and install react-native-web, react-dom, @expo/webpack-config by running: npx expo install react-native-web react-dom @expo/webpack-config",
            );
        }
    }

    private async isRunning(launchArgs: any): Promise<boolean> {
        try {
            await Request.request(launchArgs.url);
            return true;
        } catch {
            return false;
        }
    }

    private async waitExpoWebIsRunning(
        launchArgs: any,
        retryCount = 60,
        delay = 3000,
    ): Promise<void> {
        try {
            await PromiseUtil.retryAsync(
                () => this.isRunning(launchArgs),
                running => running,
                retryCount,
                delay,
                localize("ExpoWebIsNotRunning", "Expo web is not running"),
            );
        } catch (error) {
            throw error;
        }
    }
}
