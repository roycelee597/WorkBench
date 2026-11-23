use std::{
    ffi::{OsStr, OsString, c_void},
    fs::{File, OpenOptions},
    io,
    mem::{size_of, zeroed},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr::{null, null_mut},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{HANDLE, HANDLE_FLAG_INHERIT, SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Security::SECURITY_ATTRIBUTES,
    System::{
        JobObjects::{
            CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject, TerminateJobObject,
        },
        Pipes::CreatePipe,
        Threading::{
            CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
            DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess,
            INFINITE, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, PROCESS_INFORMATION,
            STARTF_USESTDHANDLES, STARTUPINFOEXW, UpdateProcThreadAttribute, WaitForSingleObject,
        },
    },
};

fn last_error_if(success: i32) -> io::Result<()> {
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain([0]).collect()
}

fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    };
    let (mut reader, mut writer) = (null_mut(), null_mut());
    // Windows 在成功时移交两个独立管道句柄。
    unsafe {
        last_error_if(CreatePipe(&mut reader, &mut writer, &attributes, 0))?;
        Ok((
            OwnedHandle::from_raw_handle(reader),
            OwnedHandle::from_raw_handle(writer),
        ))
    }
}

struct Attributes {
    // 使用指针大小的元素保证对齐，Win32 会写入这块缓冲区。
    _storage: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl Attributes {
    fn new() -> io::Result<Self> {
        let mut size = 0;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &mut size) };
        if size == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
        let list = storage.as_mut_ptr().cast();
        unsafe { last_error_if(InitializeProcThreadAttributeList(list, 2, 0, &mut size))? };
        Ok(Self {
            _storage: storage,
            list,
        })
    }

    fn set_handles(&mut self, key: u32, handles: &[HANDLE]) -> io::Result<()> {
        // 参数在 CreateProcessW 返回前一直由调用方持有。
        unsafe {
            last_error_if(UpdateProcThreadAttribute(
                self.list,
                0,
                key as usize,
                handles.as_ptr().cast::<c_void>(),
                std::mem::size_of_val(handles),
                null_mut(),
                null(),
            ))
        }
    }
}

impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.list) }
    }
}

pub struct Job(OwnedHandle);

impl Job {
    pub fn stop(&self) -> io::Result<()> {
        unsafe { last_error_if(TerminateJobObject(self.0.as_raw_handle(), 1)) }
    }
}

pub struct Process {
    pub job: Job,
    pub process: OwnedHandle,
    pub stdin: File,
    pub stdout: File,
    pub stderr: Option<File>,
}

fn environment(extra: &[(&str, OsString)]) -> Vec<u16> {
    // 只传系统目录。宿主凭据和开发环境变量不会继承。
    let mut block = Vec::new();
    if let Some(root) = std::env::var_os("SystemRoot") {
        block.extend("SystemRoot=".encode_utf16());
        block.extend(wide(&root));
    }
    // 调用方只能提供宿主生成的环境项。TEMP 和 TMP 都指向本次任务专属目录。
    for (key, value) in extra {
        block.extend(key.encode_utf16());
        block.push(b'=' as u16);
        block.extend(wide(value));
    }
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

fn append_argument(command: &mut Vec<u16>, value: &OsStr) {
    // Python / MSVC 都按 Windows argv 规则处理引号及其前面的反斜线。
    const QUOTE: u16 = b'"' as u16;
    const BACKSLASH: u16 = b'\\' as u16;
    command.push(QUOTE);
    let mut backslashes = 0;
    for unit in value.encode_wide() {
        if unit == BACKSLASH {
            backslashes += 1;
            continue;
        }
        let count = if unit == QUOTE {
            backslashes * 2 + 1
        } else {
            backslashes
        };
        command.extend(std::iter::repeat_n(BACKSLASH, count));
        backslashes = 0;
        command.push(unit);
    }
    command.extend(std::iter::repeat_n(BACKSLASH, backslashes * 2));
    command.push(QUOTE);
}

pub fn launch(
    executable: &Path,
    directory: &Path,
    arguments: &[OsString],
    extra_env: &[(&str, OsString)],
    capture_stderr: bool,
) -> io::Result<Process> {
    let app = wide(executable.as_os_str());
    let mut argv = Vec::new();
    append_argument(&mut argv, executable.as_os_str());
    for arg in arguments {
        argv.push(b' ' as u16);
        append_argument(&mut argv, arg);
    }
    argv.push(0);
    let cwd = wide(directory.as_os_str());
    let env = environment(extra_env);
    let (in_child, in_parent) = pipe()?;
    let (out_parent, out_child) = pipe()?;
    let (err_parent, err_child) = if capture_stderr {
        let (read, write) = pipe()?;
        (Some(read), write)
    } else {
        (None, OpenOptions::new().write(true).open("NUL")?.into())
    };
    // 只允许子进程继承明确列出的三个句柄，同步在创建时放入 Job。
    unsafe {
        for handle in [&in_parent, &out_parent]
            .into_iter()
            .chain(err_parent.as_ref())
        {
            last_error_if(SetHandleInformation(
                handle.as_raw_handle(),
                HANDLE_FLAG_INHERIT,
                0,
            ))?;
        }
        last_error_if(SetHandleInformation(
            err_child.as_raw_handle(),
            HANDLE_FLAG_INHERIT,
            HANDLE_FLAG_INHERIT,
        ))?;
        let job = CreateJobObjectW(null(), null());
        if job.is_null() {
            return Err(io::Error::last_os_error());
        }
        let job = OwnedHandle::from_raw_handle(job);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        last_error_if(SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ))?;
        let child_handles = [
            in_child.as_raw_handle(),
            out_child.as_raw_handle(),
            err_child.as_raw_handle(),
        ];
        let job_handles = [job.as_raw_handle()];
        let mut attributes = Attributes::new()?;
        attributes.set_handles(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &child_handles)?;
        attributes.set_handles(PROC_THREAD_ATTRIBUTE_JOB_LIST, &job_handles)?;
        let mut info: STARTUPINFOEXW = zeroed();
        info.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        info.StartupInfo.hStdInput = child_handles[0];
        info.StartupInfo.hStdOutput = child_handles[1];
        info.StartupInfo.hStdError = child_handles[2];
        info.lpAttributeList = attributes.list;
        let mut created: PROCESS_INFORMATION = zeroed();
        last_error_if(CreateProcessW(
            app.as_ptr(),
            argv.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            env.as_ptr().cast(),
            cwd.as_ptr(),
            &info.StartupInfo,
            &mut created,
        ))?;
        drop(OwnedHandle::from_raw_handle(created.hThread));
        Ok(Process {
            job: Job(job),
            process: OwnedHandle::from_raw_handle(created.hProcess),
            stdin: File::from(in_parent),
            stdout: File::from(out_parent),
            stderr: err_parent.map(File::from),
        })
    }
}

pub fn wait(process: &OwnedHandle, timeout: Option<Duration>) -> io::Result<Option<u32>> {
    unsafe {
        let timeout = timeout.map_or(INFINITE, |limit| {
            limit.as_millis().min((INFINITE - 1) as u128) as u32
        });
        match WaitForSingleObject(process.as_raw_handle(), timeout) {
            WAIT_TIMEOUT => return Ok(None),
            WAIT_OBJECT_0 => {}
            _ => return Err(io::Error::last_os_error()),
        }
        let mut code = 1;
        last_error_if(GetExitCodeProcess(process.as_raw_handle(), &mut code))?;
        Ok(Some(code))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader, Write},
        process::Command,
        sync::mpsc,
        time::Duration,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};

    #[test]
    fn cancel_stops_root_and_descendant() {
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("fixture.rs");
        let executable = fixture.path().join("fixture.exe");
        std::fs::write(&source, r#"
use std::{io::{self, BufRead, Write}, process::Command, time::Duration};
fn main() {
    if std::env::args().nth(1).as_deref() != Some("descendant") {
        assert_eq!(std::env::args().nth(1).as_deref(), Some("传入 \"quoted\" path\\"));
        assert_eq!(
            std::fs::canonicalize(std::env::var_os("TEMP").unwrap()).unwrap(),
            std::fs::canonicalize(std::env::current_dir().unwrap()).unwrap(),
        );
        assert!(std::env::var_os("TUSHARE_TOKEN").is_none());
        eprintln!("stderr fixture");
        let mut input = String::new();
        io::stdin().lock().read_line(&mut input).unwrap();
        let child = Command::new(std::env::current_exe().unwrap()).arg("descendant").spawn().unwrap();
        println!("{}", child.id());
        io::stdout().flush().unwrap();
    }
    std::thread::sleep(Duration::from_secs(60));
}
"#).unwrap();
        assert!(
            Command::new("rustc")
                .arg(&source)
                .arg("-o")
                .arg(&executable)
                .status()
                .unwrap()
                .success()
        );
        let Process {
            job,
            process,
            mut stdin,
            stdout,
            stderr,
        } = launch(
            &executable,
            fixture.path(),
            &["传入 \"quoted\" path\\".into()],
            &[("TEMP", fixture.path().as_os_str().to_owned())],
            true,
        )
        .unwrap();
        stdin.write_all(b"{}\n").unwrap();
        drop(stdin);
        let mut line = String::new();
        BufReader::new(stderr.unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim_end(), "stderr fixture");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let _ = BufReader::new(stdout).read_line(&mut line);
            let _ = tx.send(line);
        });
        let line = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let pid = line.trim().parse().unwrap();
        unsafe {
            let child = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            assert!(!child.is_null());
            let child = OwnedHandle::from_raw_handle(child);
            job.stop().unwrap();
            assert_eq!(
                WaitForSingleObject(process.as_raw_handle(), 5_000),
                WAIT_OBJECT_0
            );
            assert_eq!(
                WaitForSingleObject(child.as_raw_handle(), 5_000),
                WAIT_OBJECT_0
            );
        }
    }
}
