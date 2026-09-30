/** The update being installed. Tauri 1's updater reports no download
 *  progress, so the bar runs indeterminate until the app restarts. */

import { Modal } from "@/ui/frame";
import { PBar } from "@/ui/kit";

export function UpdateProgress({ version }: { version: string }) {
  return (
    <Modal>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={`Updating to ${version}`}>
        <div className="db">
          <div className="dt">Updating to {version}</div>
          <div className="row"><span className="grow">Downloading and installing</span></div>
          <PBar ind />
          <div className="t3">MKVBatchMux restarts when it's done. Your queue and settings are kept.</div>
        </div>
      </div>
    </Modal>
  );
}
