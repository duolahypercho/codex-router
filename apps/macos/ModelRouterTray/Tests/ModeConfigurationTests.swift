import XCTest
@testable import ModelRouterTray

final class ModeConfigurationTests: XCTestCase {
  func testDisablingCustomModeRemovesRouterProviderAndManagedBlock() throws {
    let input = """
    model = "gpt-5.6-sol"
    model_provider = "codex-router"
    # BEGIN codex-router-managed
    openai_base_url = "http://127.0.0.1:4102/v1"
    # END codex-router-managed
    """
    let result = try CodexModeController.replacingRouterBlock(in: input, enabled: false)
    XCTAssertFalse(result.contains("model_provider = \"codex-router\""))
    XCTAssertFalse(result.contains("# BEGIN codex-router-managed"))
    XCTAssertTrue(result.contains("model = \"gpt-5.6-sol\""))
  }

  func testEnablingCustomModeRestoresRouterProviderAndFlashFallback() throws {
    let input = "model = \"gpt-5.6-sol\"\ndefault_subagent_model = \"gpt-5.6-luna\"\n"
    let result = try CodexModeController.replacingRouterBlock(in: input, enabled: true)
    XCTAssertTrue(result.contains("model_provider = \"codex-router\""))
    XCTAssertTrue(result.contains("default_subagent_model = \"opencode-go/deepseek-v4-flash\""))
    XCTAssertTrue(result.contains("# BEGIN codex-router-managed"))
  }
}
