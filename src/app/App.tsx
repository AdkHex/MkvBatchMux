import { Toaster } from "sonner";

import "@/ui/ui.css";
import { AllUsersCopyNotice } from "./AllUsersCopyNotice";
import Index from "./Index";
import { ServiceLockScreen } from "./ServiceLock";

/** Single-window desktop app: no router, and one toast system. The remote
 *  lock's screen covers all of it when it is on. */
export default function App() {
  return (
    <>
      <Index />
      <AllUsersCopyNotice />
      <Toaster position="bottom-right" offset={64} closeButton theme="system" toastOptions={{ duration: 4000, className: "mbm-toast" }} />
      <ServiceLockScreen />
    </>
  );
}
