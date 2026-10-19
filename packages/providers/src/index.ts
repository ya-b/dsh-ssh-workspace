/**
 * The daemon-backed `ctx.ssh` service and the mount that pairs it with
 * the official SSH provider family. The providers bind to the shape
 * `{request, connectStream, dispose}`; this class supplies exactly that shape
 * over `RemoteWorkspaceTransport`, so `SshFileSystem`,
 * `SshSubprocessRuntime`, `SshSandboxProvider` and `SandboxBashExecutor` run
 * unchanged.
 * @module @dsh-ssh-workspace/providers
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { z } from 'zod'
import { RemoteWorkspaceTransport, type RemoteWorkspaceConfig, type StreamEndpoint } from '@dsh-ssh-workspace/transport'

// The service is registered under the harness's own `ssh` name. Its declared
// type stays the upstream `SshConnection`; this class is a runtime-compatible
// substitute, so no context augmentation is added here.

/** Holds the transport instance a host's providers share. */
export interface DaemonSshConfig {
  /** Live transport for the target host; the mount plugin owns its lifetime. */
  transport: RemoteWorkspaceTransport
}

/**
 * Shape-compatible `ctx.ssh` backed by the remote workspace daemon. The
 * official SSH providers never see the helper: `request` speaks the daemon
 * RPC, `connectStream` returns a reconnectable stream handle, and `dispose`
 * releases only local resources (the daemon keeps executing).
 */
export class DaemonSshConnection extends Service {
  private readonly transport: RemoteWorkspaceTransport

  constructor(ctx: Context, config: DaemonSshConfig) {
    super(ctx, 'ssh')
    this.transport = config.transport
  }

  /** Ready once the daemon handshake completed. */
  get ready(): Promise<void> { return this.transport.open() }

  /** Verified remote coordinates when the handshake has completed. */
  get remote(): { root: string; workspace: string; instanceId: string; nodeVersion: string } | undefined {
    const hello = this.transport.hello
    return hello === undefined ? undefined : {
      root: hello.root, workspace: hello.workspace, instanceId: hello.instanceId, nodeVersion: hello.nodeVersion,
    }
  }

  /**
   * Send one daemon operation with the official provider call signature.
   * @param method - daemon operation.
   * @param params - request fields.
   * @param result - response schema.
   * @param signal - cancellation.
   * @param wait - allow an observation to outlast the administrative deadline.
   */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait = false): Promise<T> {
    return await this.transport.request(method, params, result, signal, wait)
  }

  /**
   * Open one authenticated, reconnectable stream to a daemon endpoint.
   * @param endpoint - coordinates published by the daemon.
   * @param signal - cancellation of the attachment.
   */
  async connectStream(endpoint: StreamEndpoint, signal?: AbortSignal): Promise<Socket> {
    return await this.transport.connectStream(endpoint, signal) as unknown as Socket
  }

  /** Local teardown only; the daemon and its processes keep running. */
  dispose(): Promise<void> { return this.transport.dispose() }
}

/** Convenience factory: build a transport for one remote config. */
export function createTransport(config: RemoteWorkspaceConfig): RemoteWorkspaceTransport {
  return new RemoteWorkspaceTransport(config)
}

export type { Duplex, StreamEndpoint, RemoteWorkspaceConfig }
