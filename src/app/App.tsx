import { Toaster } from "sonner";

import "@/ui/ui.css";
import Index from "./Index";

/** Single-window desktop app: no router, and one toast system. */
export default function App() {
  return (
    <>
      <Index />
      <Toaster position="bottom-right" offset={64} closeButton theme="system" toastOptions={{ duration: 4000, className: "mbm-toast" }} />
    </>
  );
}
