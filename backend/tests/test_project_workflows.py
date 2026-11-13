from fastapi.testclient import TestClient

from app.main import app


client = TestClient(app)


def test_projects_list_endpoint_returns_project_metadata():
    response = client.get("/api/projects")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "projects" in payload
    assert isinstance(payload["projects"], list)


def test_project_tree_endpoint_returns_project_files():
    response = client.get("/api/projects/yangshopping/tree")
    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["success"] is True
    assert "files" in payload
    assert isinstance(payload["files"], list)
