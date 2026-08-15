import {
  fauxProvider,
  type FauxProviderHandle,
  type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface FauxRuntime {
  faux: FauxProviderHandle;
  modelRuntime: ModelRuntime;
  unregister(): void;
}

export async function createFauxRuntime(
  options: RegisterFauxProviderOptions,
): Promise<FauxRuntime> {
  const faux = fauxProvider(options);
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  return {
    faux,
    modelRuntime,
    unregister: () => modelRuntime.unregisterProvider(faux.provider.id),
  };
}
