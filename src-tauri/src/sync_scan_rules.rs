use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ScanRules {
    pub version: u8,
    pub prefixes: Vec<String>,
    pub excludes: Vec<String>,
}

impl ScanRules {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 { return Err("不支持的扫描规则版本".into()); }
        for (lines, patterns) in [(&self.prefixes, false), (&self.excludes, true)] {
            if lines.len() > 128 || lines.iter().map(|s| s.len() + 1).sum::<usize>() > 65_536 {
                return Err("扫描规则过长".into());
            }
            for line in lines {
                let unnegated = line.strip_prefix('!').unwrap_or(line);
                let body = if patterns { unnegated.strip_prefix('/').unwrap_or(unnegated) } else { line };
                if body.is_empty() || body.chars().count() > 512 || body.starts_with('/')
                    || body.chars().any(|c| c.is_control() || ":\\[]{}".contains(c))
                    || (!patterns && body.contains(['*', '?', '!']))
                    || body.strip_suffix('/').unwrap_or(body).split('/').any(|p| p.is_empty() || p == "." || p == "..")
                    || (patterns && body.split('/').any(|p| p.contains("**") && p != "**")) {
                    return Err(format!("不支持的扫描规则：{line}"));
                }
            }
        }
        Ok(())
    }

    pub fn allows(&self, rel: &str, directory: bool) -> bool {
        if !self.prefixes.is_empty() && !self.prefixes.iter().any(|p| rel.starts_with(p)
            || (directory && (p.starts_with(&format!("{rel}/")) || rel == p.trim_end_matches('/')))) { return false; }
        let parts: Vec<&str> = rel.split('/').collect();
        for end in 1..=parts.len() {
            let is_dir = end < parts.len() || directory;
            let path = parts[..end].join("/");
            let mut excluded = false;
            for raw in &self.excludes {
                let negate = raw.starts_with('!');
                let pat = raw.strip_prefix('!').unwrap_or(raw);
                let anchored = pat.starts_with('/');
                let dir_only = pat.ends_with('/');
                let pat = pat.trim_start_matches('/').trim_end_matches('/');
                if dir_only && !is_dir { continue; }
                let target = if anchored || pat.contains('/') { &path } else { parts[end - 1] };
                if glob(pat, target) { excluded = !negate; }
            }
            if excluded { return false; }
        }
        true
    }
}

fn glob(pattern: &str, path: &str) -> bool {
    let p: Vec<&str> = pattern.split('/').collect();
    let s: Vec<&str> = path.split('/').collect();
    let mut dp = vec![vec![false; s.len() + 1]; p.len() + 1];
    dp[0][0] = true;
    for i in 1..=p.len() {
        if p[i - 1] == "**" { dp[i][0] = dp[i - 1][0]; }
        for j in 1..=s.len() {
            dp[i][j] = if p[i - 1] == "**" { dp[i - 1][j] || dp[i][j - 1] }
                else { dp[i - 1][j - 1] && super::wildcard_match(p[i - 1], s[j - 1]) };
        }
    }
    dp[p.len()][s.len()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_scan_rule_fixtures() {
        let fixtures: serde_json::Value = serde_json::from_str(include_str!("../../tests/fixtures/sync_scan_rules.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            let rules: ScanRules = serde_json::from_value(fixture["rules"].clone()).unwrap();
            rules.validate().unwrap();
            for case in fixture["cases"].as_array().unwrap() {
                assert_eq!(rules.allows(case[0].as_str().unwrap(), case[1].as_bool().unwrap()),
                    case[2].as_bool().unwrap(), "{case:?} {rules:?}");
            }
        }
    }

    #[test]
    fn invalid_scan_rules() {
        for prefix in ["../x", "/root", "C:/data", "a//b", "src*", "a[bc]"] {
            assert!(ScanRules { version: 1, prefixes: vec![prefix.into()], excludes: vec![] }.validate().is_err());
        }
        for pattern in ["!", "/", "a/**b", "../*", "a/{b,c}"] {
            assert!(ScanRules { version: 1, prefixes: vec![], excludes: vec![pattern.into()] }.validate().is_err());
        }
    }
}
