package awu.engine;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.compiler.IProblem;
import org.eclipse.jdt.core.dom.AST;
import org.eclipse.jdt.core.dom.ASTParser;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.JSONUtility;

/** 固定只读诊断命令。对请求中的不可变源码做语义分析，不保存或执行项目。 */
public final class VersionedDiagnostics implements IDelegateCommandHandler {
    @Override
    public Object executeCommand(String command, List<Object> arguments, IProgressMonitor monitor) throws Exception {
        if (!"awu.java.versionedDiagnostics".equals(command) || arguments == null || arguments.size() != 1) {
            throw new IllegalArgumentException("Invalid diagnostic request");
        }
        Map<?, ?> request = JSONUtility.toModel(arguments.get(0), Map.class);
        if (request == null) throw new IllegalArgumentException("Invalid diagnostic request");
        Object uri = request.get("uri"), source = request.get("text"), revision = request.get("revision");
        if (!(uri instanceof String) || !(source instanceof String text) || !(revision instanceof Number)
                || text.length() > 2 * 1024 * 1024) {
            throw new IllegalArgumentException("Invalid diagnostic document");
        }
        ICompilationUnit unit = JDTUtils.resolveCompilationUnit((String) uri);
        if (unit == null || unit.getJavaProject() == null) {
            throw new IllegalArgumentException("Project unavailable");
        }
        ASTParser parser = ASTParser.newParser(AST.getJLSLatest());
        parser.setProject(unit.getJavaProject());
        parser.setUnitName(unit.getPath().toString());
        parser.setSource(text.toCharArray());
        parser.setResolveBindings(true);
        parser.setBindingsRecovery(true);
        parser.setStatementsRecovery(true);
        CompilationUnit syntax = (CompilationUnit) parser.createAST(monitor);
        List<Map<String, Object>> diagnostics = new ArrayList<>();
        for (IProblem problem : syntax.getProblems()) {
            if (monitor.isCanceled()) throw new InterruptedException("Diagnostic cancelled");
            if (diagnostics.size() >= 500) break;
            int start = Math.max(0, Math.min(text.length(), problem.getSourceStart()));
            int end = Math.max(start, Math.min(text.length(), problem.getSourceEnd() + 1));
            Map<String, Object> diagnostic = new HashMap<>();
            diagnostic.put("range", Map.of("start", position(text, start), "end", position(text, end)));
            diagnostic.put("severity", problem.isError() ? 1 : problem.isWarning() ? 2 : 3);
            diagnostic.put("message", problem.getMessage());
            diagnostic.put("source", "JDT LS 1.42 / AWU versioned AST");
            diagnostic.put("code", problem.getID());
            diagnostics.add(diagnostic);
        }
        return Map.of("revision", revision, "diagnostics", diagnostics, "truncated", syntax.getProblems().length > 500,
                "projectNatures", unit.getJavaProject().getProject().getDescription().getNatureIds());
    }

    private static Map<String, Integer> position(String text, int offset) {
        int line = 0, lineStart = 0;
        for (int i = 0; i < offset; i++) {
            if (text.charAt(i) == '\n') { line++; lineStart = i + 1; }
        }
        return Map.of("line", line, "character", offset - lineStart);
    }
}
