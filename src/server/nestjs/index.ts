import type { DynamicModule, FactoryProvider, ModuleMetadata, Provider } from "@nestjs/common";

import {
  Controller,
  Header,
  HttpCode,
  HttpException,
  Inject,
  InternalServerErrorException,
  Module,
  Post,
  Req,
} from "@nestjs/common";
import { channel } from "node:diagnostics_channel";

import { resolveRestDecision, type RestDecisionOptions } from "../restDecision";

interface HostRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  userId?: unknown;
}

export interface XpModuleOptions<
  Request extends HostRequest = HostRequest,
> extends RestDecisionOptions<Request> {
  route?: string;
}

export interface XpModuleAsyncOptions<Request extends HostRequest = HostRequest> {
  route?: string;
  imports?: ModuleMetadata["imports"];
  inject?: FactoryProvider["inject"];
  useFactory: FactoryProvider<RestDecisionOptions<Request>>["useFactory"];
}

const optionsToken = Symbol("xp.nest.options");
const failures = channel("xp.request.error");

function decisionController<Request extends HostRequest>(route = "/xp") {
  @Controller(route)
  class XpController {
    constructor(@Inject(optionsToken) private readonly options: RestDecisionOptions<Request>) {}

    @Post()
    @HttpCode(200)
    @Header("Cache-Control", "private, no-store")
    async resolve(@Req() request: Request) {
      const result = await resolveRestDecision(
        request,
        request.body,
        this.options,
        (name) => request.headers[name.toLowerCase()],
        () => request.userId,
      ).catch((error: unknown) => {
        failures.publish({ request, error });
        throw new InternalServerErrorException("Internal server error", { cause: error });
      });

      if (result.status !== 200) throw new HttpException(result.body, result.status);
      return result.body;
    }
  }
  return XpController;
}

@Module({})
export class XpModule {
  static register<Request extends HostRequest = HostRequest>(
    options: XpModuleOptions<Request>,
  ): DynamicModule {
    return {
      module: XpModule,
      controllers: [decisionController<Request>(options.route)],
      providers: [{ provide: optionsToken, useValue: options }],
    };
  }

  static registerAsync<Request extends HostRequest = HostRequest>({
    route,
    imports = [],
    inject = [],
    useFactory,
  }: XpModuleAsyncOptions<Request>): DynamicModule {
    const options: Provider = { provide: optionsToken, useFactory, inject };
    return {
      module: XpModule,
      imports,
      controllers: [decisionController<Request>(route)],
      providers: [options],
    };
  }
}
