package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestNormalizeGrokReviewTargets(t *testing.T) {
	workDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(workDir, "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.go", filepath.Join("nested", "b.go")} {
		if err := os.WriteFile(filepath.Join(workDir, name), []byte("package test\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	got, err := normalizeGrokReviewTargets(workDir, []string{"a.go", filepath.Join("nested", "b.go")})
	if err != nil {
		t.Fatalf("normalize targets: %v", err)
	}
	if strings.Join(got, ",") != "a.go,nested/b.go" {
		t.Fatalf("targets = %v", got)
	}

	for name, target := range map[string]string{
		"absolute": filepath.Join(workDir, "a.go"),
		"escape":   filepath.Join("..", "outside.go"),
		"missing":  "missing.go",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := normalizeGrokReviewTargets(workDir, []string{target}); err == nil {
				t.Fatalf("target %q should fail", target)
			}
		})
	}

	link := filepath.Join(workDir, "link.go")
	if err := os.Symlink(filepath.Join(workDir, "a.go"), link); err == nil {
		if _, err := normalizeGrokReviewTargets(workDir, []string{"link.go"}); err == nil {
			t.Fatal("symlink target should fail")
		}
	}
}

func TestParseArgsGrokReviewTargets(t *testing.T) {
	originalArgs := os.Args
	os.Args = []string{
		"codeagent-wrapper",
		"--backend", "grok",
		"--grok-review-target", "a.go",
		"--grok-review-target=nested/b.go",
		"review",
	}
	t.Cleanup(func() { os.Args = originalArgs })

	cfg, err := parseArgs()
	if err != nil {
		t.Fatalf("parse args: %v", err)
	}
	if strings.Join(cfg.GrokReviewTargets, ",") != "a.go,nested/b.go" {
		t.Fatalf("review targets = %v", cfg.GrokReviewTargets)
	}
}

func TestGrokBuildArgs_ReviewModeIsReadOnly(t *testing.T) {
	args := buildGrokArgs(&Config{
		Mode:              "new",
		Backend:           "grok",
		GrokReviewTargets: []string{"a.go"},
	}, "C:/tmp/review/prompt.json")
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "--always-approve") {
		t.Fatalf("review args must not contain --always-approve: %v", args)
	}
	for _, want := range []string{
		"--tools todo_write",
		"--disable-web-search",
		"--no-memory",
		"--no-plan",
		"--no-subagents",
		"--no-auto-update",
		"--permission-mode dontAsk",
		"--deny MCPTool(*)",
		"--system-prompt-override",
		"--verbatim",
		"--output-format streaming-json",
		"--prompt-file C:/tmp/review/prompt.json",
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("review args missing %q: %v", want, args)
		}
	}
	for _, forbidden := range []string{"read_file", "grep", "list_dir", " -p "} {
		if strings.Contains(" "+joined+" ", forbidden) {
			t.Fatalf("review args must not expose filesystem tools or argv prompt %q: %v", forbidden, args)
		}
	}
}

func TestGrokBuildArgs_ReviewModeNeverResumes(t *testing.T) {
	args := buildGrokArgs(&Config{
		Mode:              "resume",
		SessionID:         "old-session",
		Backend:           "grok",
		GrokReviewTargets: []string{"a.go"},
	}, "C:/tmp/review/prompt.json")
	if strings.Contains(" "+strings.Join(args, " ")+" ", " -r ") {
		t.Fatalf("review args must not resume prior context: %v", args)
	}
}

func TestPrepareGrokReviewPromptOnlyIncludesTargets(t *testing.T) {
	workDir := t.TempDir()
	files := map[string]string{
		"a.go":     "package a\n",
		"other.go": "SECRET_OUTSIDE_SCOPE\n",
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(workDir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	dir, promptFile, err := prepareGrokReviewPrompt(workDir, "find bugs", []string{"a.go"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	if filepath.Dir(promptFile) != dir {
		t.Fatalf("prompt file %q must live in isolated dir %q", promptFile, dir)
	}
	data, err := os.ReadFile(promptFile)
	if err != nil {
		t.Fatal(err)
	}
	prompt := string(data)
	if !strings.Contains(prompt, "find bugs") || !strings.Contains(prompt, "package a") {
		t.Fatalf("prompt missing request or target content: %s", prompt)
	}
	if strings.Contains(prompt, "SECRET_OUTSIDE_SCOPE") || strings.Contains(prompt, "other.go") {
		t.Fatalf("prompt leaked non-target file: %s", prompt)
	}
	if err := os.WriteFile(filepath.Join(workDir, "binary.bin"), []byte{0xff}, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := prepareGrokReviewPrompt(workDir, "review", []string{"binary.bin"}); err == nil || !strings.Contains(err.Error(), "UTF-8") {
		t.Fatalf("non-UTF-8 target must fail closed, got %v", err)
	}
}

func TestValidateGrokReviewSnapshotMode(t *testing.T) {
	evidence := newGrokReviewEvidence()
	evidence.observeStopReason("end_turn")
	if err := validateGrokReview("", "plain review prose", []string{"a.go"}, evidence); err != nil {
		t.Fatalf("validate snapshot review: %v", err)
	}

	evidence.observeToolCall("call-1", "completed", "read_file", "other.go")
	if err := validateGrokReview("", "plain review prose", []string{"a.go"}, evidence); err == nil || !strings.Contains(err.Error(), "attempted tool") {
		t.Fatalf("tool call must fail closed, got %v", err)
	}

	failed := newGrokReviewEvidence()
	failed.observeStopReason("error")
	if err := validateGrokReview("", "partial prose", []string{"a.go"}, failed); err == nil || !strings.Contains(err.Error(), "stop reason") {
		t.Fatalf("error stop reason must fail closed, got %v", err)
	}
}

func TestParseGrokReviewACP(t *testing.T) {
	evidence := newGrokReviewEvidence()
	stream := strings.Join([]string{
		`{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"call-1","rawInput":{"target_file":"a.go"}}}}`,
		`{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","kind":"read","rawInput":{"variant":"ReadFile","target_file":"a.go"}}}}`,
		`{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed"}}}`,
		`{"method":"_x.ai/session/update","params":{"update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}}}`,
		`{"type":"text","data":"done"}`,
		`{"type":"end","stopReason":"EndTurn","sessionId":"session-1"}`,
	}, "\n")

	message, threadID, terminalError := parseJSONStreamInternalWithReview(
		strings.NewReader(stream), nil, nil, nil, nil, nil, nil, nil, evidence,
	)
	if message != "done" || threadID != "session-1" || terminalError != "" {
		t.Fatalf("parse result = (%q, %q, %q)", message, threadID, terminalError)
	}
	call := evidence.calls["call-1"]
	if call == nil || call.variant != "ReadFile" || call.path != "a.go" || !call.completed {
		t.Fatalf("evidence call = %+v", call)
	}
}

func TestParseGrokReviewStreamingJSON(t *testing.T) {
	evidence := newGrokReviewEvidence()
	var warnings []string
	stream := strings.Join([]string{
		`{"type":"tool_call","toolCallId":"call-read","title":"read_file","toolName":"read_file","rawInput":{"target_file":"a.go"},"content":[]}`,
		`{"type":"tool_call_update","toolCallId":"call-read","status":null,"content":[],"rawOutput":null}`,
		`{"type":"tool_call_update","toolCallId":"call-read","status":"completed","content":[{"type":"content","content":{"type":"text","text":"package test"}}]}`,
		`{"type":"tool_call","toolCallId":"call-grep","title":"grep","toolName":"grep","rawInput":{"pattern":"package","path":"b.go"},"content":[]}`,
		`{"type":"tool_call_update","toolCallId":"call-grep","status":"completed","content":[{"type":"content","content":{"type":"text","text":"found 1 matches"}}]}`,
		`{"type":"text","data":"done"}`,
		`{"type":"end","stopReason":"end_turn","sessionId":"session-1"}`,
	}, "\n")

	message, threadID, terminalError := parseJSONStreamInternalWithReview(
		strings.NewReader(stream), func(message string) { warnings = append(warnings, message) }, nil, nil, nil, nil, nil, nil, evidence,
	)
	if message != "done" || threadID != "session-1" || terminalError != "" || len(warnings) != 0 {
		t.Fatalf("parse result = (%q, %q, %q), warnings = %v", message, threadID, terminalError, warnings)
	}
	for id, want := range map[string]grokToolCall{
		"call-read": {variant: "ReadFile", path: "a.go", completed: true},
		"call-grep": {variant: "Grep", path: "b.go", completed: true},
	} {
		call := evidence.calls[id]
		if call == nil || *call != want {
			t.Fatalf("%s = %+v, want %+v", id, call, want)
		}
	}
}

func TestRunGrokReviewUsesIsolatedSnapshotAndWrapperEnvelope(t *testing.T) {
	workDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workDir, "a.go"), []byte("package test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := newFakeCmd(fakeCmdConfig{StdoutPlan: []fakeStdoutEvent{{Data: strings.Join([]string{
		`{"type":"text","data":"review complete"}`,
		`{"type":"end","stopReason":"EndTurn","sessionId":"session-1"}`,
	}, "\n") + "\n"}}})
	originalRunner := newCommandRunner
	originalLite := liteMode
	newCommandRunner = func(context.Context, string, ...string) commandRunner { return fake }
	liteMode = true
	t.Cleanup(func() {
		newCommandRunner = originalRunner
		liteMode = originalLite
	})

	result := runCodexTaskWithContext(context.Background(), TaskSpec{
		Task:              "review",
		WorkDir:           workDir,
		Backend:           "grok",
		GrokReviewTargets: []string{"a.go"},
	}, GrokBackend{}, nil, false, true, 2)
	if result.ExitCode != 0 {
		t.Fatalf("result = %+v", result)
	}
	if fake.Dir() == workDir || filepath.Dir(fake.Dir()) != os.TempDir() {
		t.Fatalf("Grok review dir = %q, want isolated temp dir outside %q", fake.Dir(), workDir)
	}
	if _, err := os.Stat(fake.Dir()); !os.IsNotExist(err) {
		t.Fatalf("isolated review dir must be removed, stat error = %v", err)
	}
	wantSuffix := grokReviewMarker + `{"schemaVersion":1,"reviewedFiles":["a.go"],"findings":[]}`
	if !strings.HasSuffix(result.Message, wantSuffix) {
		t.Fatalf("message = %q, want wrapper envelope suffix %q", result.Message, wantSuffix)
	}
}

func TestRunGrokReviewRejectsResumeBeforeProviderLaunch(t *testing.T) {
	workDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(workDir, "a.go"), []byte("package test\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	fake := newFakeCmd(fakeCmdConfig{})
	originalRunner := newCommandRunner
	newCommandRunner = func(context.Context, string, ...string) commandRunner { return fake }
	t.Cleanup(func() { newCommandRunner = originalRunner })

	result := runCodexTaskWithContext(context.Background(), TaskSpec{
		Task:              "review",
		WorkDir:           workDir,
		Mode:              "resume",
		SessionID:         "old-session",
		Backend:           "grok",
		GrokReviewTargets: []string{"a.go"},
	}, GrokBackend{}, nil, false, true, 2)
	if result.ExitCode == 0 || !strings.Contains(result.Error, "fresh isolated session") {
		t.Fatalf("resume review must fail closed, got %+v", result)
	}
	if fake.startCount.Load() != 0 {
		t.Fatalf("provider started before resume rejection: %d", fake.startCount.Load())
	}
}
