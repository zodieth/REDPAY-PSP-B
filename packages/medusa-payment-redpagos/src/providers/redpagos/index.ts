import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import RedpagosProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [RedpagosProviderService],
})
