// OpenBGR.exe - zero-dependency Windows launcher / first-run bootstrapper.
// Compiled by scripts/build_release.py with the .NET Framework `csc.exe`
// (no NuGet/MSBuild required). GUI launches show a WinForms setup window while
// start.bat provisions the Python + PyTorch runtime into .venv; headless
// invocations (--cli / --quick-action) run hidden.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using System.Threading;
using System.Windows.Forms;

class OpenBGRLauncher {
    static string QuoteCmdArg(string a) {
        return "\"" + a.Replace("\"", "\"\"") + "\"";
    }

    static bool IsRuntimeReady(string dir) {
        return File.Exists(Path.Combine(dir, ".venv", ".installed"))
            && File.Exists(Path.Combine(dir, ".venv", "Scripts", "python.exe"));
    }

    static bool RunStartBatWithGui(string dir, string argLine) {
        Form form = new Form();
        form.Text = "OpenBGR \u2014 First-Time Setup";
        form.FormBorderStyle = FormBorderStyle.FixedDialog;
        form.MaximizeBox = false;
        form.StartPosition = FormStartPosition.CenterScreen;
        form.ClientSize = new Size(460, 148);
        form.BackColor = Color.FromArgb(18, 18, 21);
        form.ForeColor = Color.FromArgb(244, 244, 245);
        try {
            string ico = Path.Combine(dir, "OpenBGR.ico");
            if (File.Exists(ico)) form.Icon = new Icon(ico);
        } catch {}

        Label title = new Label();
        title.Text = "Setting up local AI engine (one-time setup)";
        title.Font = new Font("Segoe UI", 10F, FontStyle.Bold);
        title.Location = new Point(20, 18);
        title.Size = new Size(420, 22);
        form.Controls.Add(title);

        Label status = new Label();
        status.Text = "Preparing standalone Python 3.12 runtime and PyTorch...";
        status.Font = new Font("Consolas", 8.5F, FontStyle.Regular);
        status.ForeColor = Color.FromArgb(161, 161, 170);
        status.Location = new Point(20, 46);
        status.Size = new Size(420, 34);
        status.AutoEllipsis = true;
        form.Controls.Add(status);

        ProgressBar bar = new ProgressBar();
        bar.Style = ProgressBarStyle.Marquee;
        bar.MarqueeAnimationSpeed = 28;
        bar.Location = new Point(20, 88);
        bar.Size = new Size(420, 18);
        form.Controls.Add(bar);

        Label hint = new Label();
        hint.Text = "The workspace opens automatically when finished (~1\u20133 min).";
        hint.Font = new Font("Segoe UI", 8.25F, FontStyle.Regular);
        hint.ForeColor = Color.FromArgb(113, 113, 122);
        hint.Location = new Point(20, 114);
        hint.Size = new Size(420, 18);
        form.Controls.Add(hint);

        Process proc = new Process();
        StringBuilder tail = new StringBuilder();
        int exitCode = -1;
        bool finished = false;

        form.FormClosing += delegate(object s, FormClosingEventArgs e) {
            if (!finished) {
                try { if (!proc.HasExited) proc.Kill(); } catch {}
            }
        };

        form.Shown += delegate {
            Thread worker = new Thread(delegate() {
                try {
                    string logDir = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                        ".openbgr"
                    );
                    Directory.CreateDirectory(logDir);
                    string logFile = Path.Combine(logDir, "setup.log");

                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = "cmd.exe";
                    psi.Arguments = "/c \"\"" + Path.Combine(dir, "start.bat") + "\"" + argLine + "\"";
                    psi.WorkingDirectory = dir;
                    psi.UseShellExecute = false;
                    psi.CreateNoWindow = true;
                    psi.RedirectStandardOutput = true;
                    psi.RedirectStandardError = true;
                    psi.EnvironmentVariables["OPENBGR_NO_PAUSE"] = "1";

                    proc.StartInfo = psi;
                    DataReceivedEventHandler onLine = delegate(object sender, DataReceivedEventArgs ev) {
                        if (string.IsNullOrEmpty(ev.Data)) return;
                        string line = ev.Data.Trim();
                        if (line.Length == 0 || line.StartsWith("---")) return;
                        lock (tail) {
                            if (tail.Length > 2000) tail.Remove(0, 1000);
                            tail.AppendLine(line);
                            try { File.AppendAllText(logFile, line + Environment.NewLine); } catch {}
                        }
                        try {
                            form.BeginInvoke((MethodInvoker)delegate {
                                status.Text = line;
                            });
                        } catch {}
                    };
                    proc.OutputDataReceived += onLine;
                    proc.ErrorDataReceived += onLine;
                    proc.Start();
                    proc.BeginOutputReadLine();
                    proc.BeginErrorReadLine();

                    // Close the progress window as soon as provisioning completes
                    // (.venv\.installed appears) so it does not stay up while the
                    // long-lived desktop window is running.
                    while (!proc.WaitForExit(350)) {
                        if (IsRuntimeReady(dir)) {
                            Thread.Sleep(600);
                            exitCode = 0;
                            break;
                        }
                    }
                    if (proc.HasExited && exitCode < 0) exitCode = proc.ExitCode;
                } catch (Exception ex) {
                    lock (tail) { tail.AppendLine(ex.Message); }
                    exitCode = 1;
                }
                finished = true;
                try { form.BeginInvoke((MethodInvoker)delegate { form.Close(); }); } catch {}
            });
            worker.IsBackground = true;
            worker.Start();
        };

        Application.EnableVisualStyles();
        Application.Run(form);

        if (exitCode != 0 && !IsRuntimeReady(dir)) {
            string details = tail.ToString().Trim();
            if (details.Length > 600) details = details.Substring(details.Length - 600);
            MessageBox.Show(
                "OpenBGR could not finish setting up its Python runtime.\n\n"
                + (details.Length > 0 ? details + "\n\n" : "")
                + "Check your internet connection or see %USERPROFILE%\\.openbgr\\setup.log.",
                "OpenBGR Setup Failed",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error
            );
            return false;
        }
        return true;
    }

    [STAThread]
    static void Main(string[] args) {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string argLine = "";
        foreach (string a in args) argLine += " " + QuoteCmdArg(a);

        bool headless = Array.Exists(
            args,
            a => a == "--quick-action" || a == "--cli" || a == "--help" || a == "-h" || a == "--version"
        );
        if (!headless && !IsRuntimeReady(dir)) {
            if (!RunStartBatWithGui(dir, argLine)) Environment.Exit(1);
            return;
        }

        ProcessStartInfo psi = new ProcessStartInfo();
        psi.FileName = "cmd.exe";
        psi.Arguments = "/c \"\"" + Path.Combine(dir, "start.bat") + "\"" + argLine + "\"";
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        Process.Start(psi);
    }
}
