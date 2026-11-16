from app import archinfo, worklog


def spring_docs():
    base = "src/main/kotlin/com/ehs/safety"
    return {
        "build.gradle.kts": 'plugins { kotlin("jvm") }\ndependencies { implementation("org.mybatis.spring.boot:mybatis-spring-boot-starter:3.0.3") }',
        "src/main/resources/application.yml": "spring:\n  datasource:\n    url: jdbc:oracle:thin:@db\n    password: SuperSecret1\napi-key: abc",
        f"{base}/controller/IncidentController.kt": "@RestController\nclass IncidentController(private val s: IncidentService) {}\n" * 40,
        f"{base}/service/IncidentService.kt": "@Service\n@Transactional\nclass IncidentService(private val m: IncidentMapper) {}\n" * 40,
        f"{base}/mapper/IncidentMapper.kt": "@Mapper\ninterface IncidentMapper { fun findAll(): List<IncidentVo> }\n" * 30,
        "src/main/resources/mapper/IncidentMapper.xml": "<mapper namespace=\"IncidentMapper\"><select id=\"findAll\">SELECT * FROM INCIDENT</select></mapper>\n" * 20,
        f"{base}/vo/IncidentVo.kt": "data class IncidentVo(val id: Long)\n" * 30,
        "src/test/kotlin/com/ehs/IncidentServiceTest.kt": "class IncidentServiceTest {}\n" * 30,
    }


def test_spring_evidence_classifies_layers_and_masks_secrets():
    kind, ev = archinfo.collect_evidence(spring_docs())
    assert kind == "spring"
    for layer in ("controller=1", "service=1", "mapper-xml=1", "repository=1", "entity=1", "test=1"):
        assert layer in ev
    assert "SAMPLE [mapper-xml]" in ev and "SAMPLE [controller]" in ev
    assert "SuperSecret1" not in ev and "password: ***" in ev and "api-key: ***" in ev


def test_flutter_evidence():
    docs = {
        "pubspec.yaml": "dependencies:\n  flutter_bloc: ^8.1.0\n  go_router: ^14.0.0\n  dio: ^5.0.0",
        "lib/main.dart": "void main() => runApp(App());\n" * 30,
        "lib/features/report/presentation/report_screen.dart": "class ReportScreen extends StatelessWidget {}\n" * 40,
        "lib/features/report/bloc/report_bloc.dart": "class ReportBloc extends Bloc<E, S> {}\n" * 40,
        "lib/features/report/data/report_repository.dart": "class ReportRepository {}\n" * 40,
        "lib/core/router/app_router.dart": "final router = GoRouter(routes: []);\n" * 30,
        "lib/features/report/model/report.freezed.dart": "// generated\n" * 50,
    }
    kind, ev = archinfo.collect_evidence(docs)
    assert kind == "flutter"
    assert "SAMPLE [state] lib/features/report/bloc/report_bloc.dart" in ev
    assert "SAMPLE [routing]" in ev and "SAMPLE [entry] lib/main.dart" in ev
    assert "SAMPLE [generated]" not in ev  # 생성 파일은 예시로 쓰지 않음


def test_analyze_writes_doc(tmp_path, monkeypatch):
    monkeypatch.setattr(archinfo, "DIR", tmp_path)

    class R:
        text = "```markdown\n<think>x</think>## 개요\nSpring + MyBatis\n```"

    seen = {}
    monkeypatch.setattr(archinfo.llm_client, "chat", lambda msgs, **kw: seen.setdefault("m", msgs) and R())
    md = archinfo.analyze("gehs", spring_docs())
    assert md.startswith("# gehs 아키텍처") and "## 개요\nSpring + MyBatis" in md and "<think>" not in md
    assert archinfo.get("gehs") == md + "\n" and archinfo.is_fresh("gehs")
    assert "SuperSecret1" not in seen["m"][1]["content"]


def test_worklog_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(worklog, "DIR", tmp_path)
    for i in range(3):
        worklog.add("gehs_mobile", f"요청 {i}", f"한 일 {i}", ["lib/a.dart"])
    items = worklog.recent("gehs_mobile", 2)
    assert [i["request"] for i in items] == ["요청 1", "요청 2"]
    text = worklog.render("gehs_mobile")
    assert "요청: 요청 0" in text and "파일: lib/a.dart" in text
    assert worklog.render("other") == ""


def test_register_pending_remote_path(tmp_path, monkeypatch):
    from app import remote
    monkeypatch.setattr(remote, "REGISTRY", tmp_path / "rp.json")
    rec = remote.register_pending("/Users/labvantagekorea/work/gehs_mobile")
    assert rec["name"] == "gehs_mobile" and rec["status"] == "waiting-pc"
    rec2 = remote.register_pending("C:\\\\work\\\\EHS Backend", name="")
    assert rec2["name"] == "ehs-backend"
    assert {p["name"] for p in remote.pending()} == {"gehs_mobile", "ehs-backend"}
    remote.remove("gehs_mobile")
    assert [p["name"] for p in remote.pending()] == ["ehs-backend"]
