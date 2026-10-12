//! Helper processes end when the app does, however the app ends.
//!
//! An update ends the app with `exit(0)` the moment the installer starts, which
//! skips every shutdown handler: the analysis engine, and any FFmpeg or
//! MKVToolNix run it had going, were left running -- the engine and FFmpeg from
//! the install folder, holding files the installer has to replace. A crash or an
//! End task in Task Manager left them the same way.
//!
//! On Windows each helper is put in a job object set to end everything in it
//! when its last handle closes. The only handle is the app's, which Windows
//! closes as the app ends, by any route. A helper's own children (the engine's
//! FFmpeg) are in the job from the moment they start.

use std::process::Child;

/// Tie `child` to the app's lifetime. Does nothing off Windows, and nothing if
/// Windows refuses -- the helper then simply outlives the app, as before.
pub fn adopt(child: &Child) {
    #[cfg(windows)]
    windows::adopt(child);
    #[cfg(not(windows))]
    let _ = child;
}

#[cfg(windows)]
mod windows {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// A job that ends every process in it when it is closed.
    pub struct Job(HANDLE);

    // A job handle may be used from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Option<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle == 0 {
                    return None;
                }
                let job = Job(handle);
                let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let set = SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                (set != 0).then_some(job)
            }
        }

        pub fn assign(&self, child: &Child) -> bool {
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) != 0 }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// The app's job: created on first use and never closed by the app itself,
    /// so it lasts exactly as long as the process.
    static APP_JOB: OnceLock<Option<Job>> = OnceLock::new();

    pub fn adopt(child: &Child) {
        if let Some(job) = APP_JOB.get_or_init(Job::new) {
            job.assign(child);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::Job;
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        use std::time::{Duration, Instant};

        #[test]
        fn closing_the_job_ends_the_helper() {
            // `cmd` waiting on `ping` stands in for the engine waiting on FFmpeg.
            let mut helper = Command::new("cmd")
                .args(["/C", "ping -n 60 127.0.0.1 >NUL"])
                .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
                .spawn()
                .expect("start cmd");
            let job = Job::new().expect("create job");
            assert!(job.assign(&helper), "assign the helper to the job");
            assert!(helper.try_wait().unwrap().is_none(), "the helper is running");

            drop(job);

            let started = Instant::now();
            while helper.try_wait().unwrap().is_none() {
                assert!(
                    started.elapsed() < Duration::from_secs(5),
                    "the helper outlived its job"
                );
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}
