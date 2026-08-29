// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    if let Some(index) = arguments
        .iter()
        .position(|value| value == "--agentwithu-update-helper")
    {
        let plan = arguments.get(index + 1).map(String::as_str).unwrap_or("");
        std::process::exit(agent_with_u_lib::run_update_helper(plan));
    }
    agent_with_u_lib::run()
}
