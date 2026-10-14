/** Said once on Windows when an older release is still installed for all
 *  users: this copy is per user, and the installer has no rights to remove
 *  the old one (src-tauri/src/all_users_copy.rs). */

import { useEffect, useState } from "react";

import { allUsersCopyNotice, dismissAllUsersCopyNotice, type AllUsersCopy } from "@/shared/lib/backend";
import { Dialog } from "@/ui/frame";
import { Btn } from "@/ui/kit";

export function AllUsersCopyNotice() {
  const [copy, setCopy] = useState<AllUsersCopy | null>(null);
  useEffect(() => {
    allUsersCopyNotice()
      .then(setCopy)
      .catch(() => undefined);
  }, []);
  if (!copy) return null;

  const close = () => {
    setCopy(null);
    void dismissAllUsersCopyNotice().catch(() => undefined);
  };

  return (
    <Dialog size="mid" title="An all-users copy is still installed" onClose={close} foot={<Btn accent onClick={close}>OK</Btn>}>
      <p>
        An older MKVBatchMux is installed for every account on this PC, in <b>{copy.path}</b>. This copy is installed for you
        only, and other accounts can still start the old one.
      </p>
      <p>To remove it, an administrator uninstalls MKVBatchMux from Settings › Apps (the entry installed for all users).</p>
    </Dialog>
  );
}
