# Contributing to VoiceTranscriber

Thank you for your interest in contributing to VoiceTranscriber! This document provides guidelines and information for contributors.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [How Can I Contribute?](#how-can-i-contribute)
- [Development Setup](#development-setup)
- [Code Style Guidelines](#code-style-guidelines)
- [Pull Request Process](#pull-request-process)
- [Issue Reporting](#issue-reporting)
- [Feature Requests](#feature-requests)
- [Testing](#testing)
- [Documentation](#documentation)

---

## Code of Conduct

This project follows a simple code of conduct:

- Be respectful and inclusive
- Focus on constructive feedback
- Help others learn and grow
- Keep discussions professional and on-topic

---

## How Can I Contribute?

### Non-Code Contributions

- **Report bugs**: Help us find and fix issues
- **Suggest features**: Share ideas for improvements
- **Improve documentation**: Fix typos, clarify instructions, add examples
- **Help other users**: Answer questions in issues and discussions
- **Spread the word**: Share the project with others

### Code Contributions

- **Bug fixes**: Fix reported issues
- **New features**: Implement requested features
- **Performance improvements**: Optimize existing code
- **Test coverage**: Add or improve tests
- **Refactoring**: Improve code quality and maintainability

---

## Development Setup

### Prerequisites

- **Node.js** (v16 or higher)
- **Git**
- **Discord** with BetterDiscord installed
- **Code editor** (VS Code recommended)

### Initial Setup

1. **Fork the repository** on GitHub

2. **Clone your fork**:
```bash
git clone https://github.com/YOUR_USERNAME/Discord_Call_Transcript.git
cd Discord_Call_Transcript
```

3. **Add the upstream remote**:
```bash
git remote add upstream https://github.com/yourusername/Discord_Call_Transcript.git
```

4. **Install dependencies**:
```bash
npm install
```

5. **Create a development symlink** (so Discord loads your local version):

**Windows (Command Prompt as Administrator)**:
```cmd
mklink "C:\Users\%USERNAME%\AppData\Roaming\BetterDiscord\plugins\VoiceTranscriber.plugin.js" "C:\path\to\Discord_Call_Transcript\VoiceTranscriber.plugin.js"
```

**Windows (PowerShell as Administrator)**:
```powershell
New-Item -ItemType SymbolicLink -Path "$env:APPDATA\BetterDiscord\plugins\VoiceTranscriber.plugin.js" -Target "C:\path\to\Discord_Call_Transcript\VoiceTranscriber.plugin.js"
```

**macOS/Linux**:
```bash
ln -s /path/to/Discord_Call_Transcript/VoiceTranscriber.plugin.js ~/Library/Application\ Support/BetterDiscord/plugins/VoiceTranscriber.plugin.js
```

6. **Verify setup**:
   - Restart Discord
   - Check that the plugin loads from your development directory
   - Make a small change and reload Discord (Ctrl+R) to see it take effect

### Development Workflow

1. **Create a feature branch**:
```bash
git checkout -b feature/your-feature-name
```

2. **Make your changes**:
   - Edit the plugin code
   - Test in Discord by reloading (Ctrl+R or Cmd+R)
   - Check the developer console for errors (Ctrl+Shift+I or Cmd+Option+I)

3. **Test thoroughly**:
   - Test with different Discord versions
   - Test with various voice channel configurations
   - Check for conflicts with other plugins

4. **Commit your changes**:
```bash
git add .
git commit -m "feat: add descriptive commit message"
```

5. **Push to your fork**:
```bash
git push origin feature/your-feature-name
```

6. **Create a pull request** (see Pull Request Process below)

---

## Code Style Guidelines

### JavaScript/TypeScript

- **Indentation**: 2 spaces (no tabs)
- **Quotes**: Single quotes for strings
- **Semicolons**: Always use semicolons
- **Braces**: Opening brace on same line
- **Line length**: Max 100 characters

Example:
```javascript
function exampleFunction(param1, param2) {
  const result = param1 + param2;
  if (result > 10) {
    console.log('Result is large');
    return result;
  }
  return null;
}
```

### Naming Conventions

- **Variables/Functions**: camelCase (`getUserData`, `transcriptCount`)
- **Classes**: PascalCase (`VoiceTranscriber`, `AudioCapture`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_RETRY_COUNT`, `API_ENDPOINT`)
- **Files**: kebab-case (`audio-capture.js`, `transcript-export.js`)

### Comments

- Use JSDoc for function documentation
- Add inline comments for complex logic
- Keep comments up-to-date with code changes

```javascript
/**
 * Captures audio from a specific user in the voice channel
 * @param {string} userId - The Discord user ID
 * @param {number} duration - Recording duration in milliseconds
 * @returns {Promise<AudioBuffer>} The captured audio data
 */
async function captureUserAudio(userId, duration) {
  // Implementation here
}
```

### Error Handling

- Always handle errors gracefully
- Provide meaningful error messages
- Log errors to the console for debugging
- Don't expose sensitive information in error messages

```javascript
try {
  await transcribeAudio(audioData);
} catch (error) {
  console.error('Transcription failed:', error.message);
  // Show user-friendly error
  showToast('Transcription failed. Please check your API key.');
}
```

### Plugin Structure

Follow the BetterDiscord plugin structure:

```javascript
/**
 * @name VoiceTranscriber
 * @version 1.0.0
 * @description Real-time voice call transcription
 * @author YourName
 * @authorId 123456789
 * @website https://github.com/yourusername/Discord_Call_Transcript
 * @source https://github.com/yourusername/Discord_Call_Transcript
 */

module.exports = class VoiceTranscriber {
  constructor() {
    // Initialization
  }

  start() {
    // Plugin startup logic
  }

  stop() {
    // Cleanup logic
  }

  getSettingsPanel() {
    // Settings UI
  }
};
```

---

## Pull Request Process

### Before Submitting

1. **Ensure your code works**:
   - Test all changes thoroughly
   - Check for regressions
   - Verify on both Windows and macOS if possible

2. **Update documentation**:
   - Update README.md if adding features
   - Update INSTALL.md if changing setup process
   - Add inline code comments

3. **Follow the code style**:
   - Run a linter if available
   - Match existing code patterns
   - Keep changes focused and atomic

### Creating a Pull Request

1. **Push your branch** to your fork

2. **Go to the original repository** on GitHub

3. **Click "New Pull Request"**

4. **Select your branch** as the source

5. **Fill out the PR template**:

```markdown
## Description
Brief description of what this PR does

## Changes
- List of changes made
- Another change
- And another

## Testing
- How you tested the changes
- Test cases covered

## Screenshots
If applicable, add screenshots or GIFs

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] No breaking changes (or documented if intentional)
- [ ] Tested on Windows/macOS
```

6. **Submit the PR**

### After Submitting

- **Respond to reviews**: Address feedback promptly
- **Make requested changes**: Push updates to your branch
- **Keep the PR updated**: Rebase if needed
- **Be patient**: Maintainers will review when possible

---

## Issue Reporting

### Before Reporting

1. **Search existing issues** to avoid duplicates
2. **Check if you're using the latest version**
3. **Gather information**:
   - Discord version
   - BetterDiscord version
   - Plugin version
   - Operating system
   - Steps to reproduce

### Creating an Issue

Use this template when reporting bugs:

```markdown
## Bug Description
Clear description of the bug

## Steps to Reproduce
1. Step one
2. Step two
3. Step three
4. See error

## Expected Behavior
What should happen

## Actual Behavior
What actually happens

## Environment
- Discord version: 
- BetterDiscord version: 
- Plugin version: 
- Operating system: 
- Browser (if applicable): 

## Screenshots/Videos
If applicable, add visual evidence

## Console Errors
Paste any errors from the developer console (Ctrl+Shift+I)

## Additional Context
Any other relevant information
```

### Issue Labels

We use these labels to organize issues:

- `bug`: Something isn't working
- `enhancement`: New feature or improvement
- `documentation`: Documentation improvements
- `good first issue`: Good for newcomers
- `help wanted`: Community help needed
- `question`: Further information needed
- `wontfix`: Will not be fixed

---

## Feature Requests

### Before Requesting

1. **Search existing feature requests** to avoid duplicates
2. **Consider the scope**: Is it aligned with the plugin's purpose?
3. **Think about implementation**: Is it technically feasible?

### Creating a Feature Request

Use this template:

```markdown
## Feature Description
Clear description of the feature

## Problem Statement
What problem does this solve?

## Proposed Solution
How should it work?

## Alternative Solutions
Other approaches you considered

## Use Cases
Real-world scenarios where this would be useful

## Mockups/Examples
If applicable, add visual examples

## Additional Context
Any other relevant information
```

### Feature Evaluation

Features are evaluated based on:

- **Usefulness**: Does it solve a real problem?
- **Feasibility**: Can it be implemented with available APIs?
- **Performance**: Will it impact Discord's performance?
- **Maintenance**: Is it sustainable long-term?
- **Community interest**: Do others want this feature?

---

## Testing

### Manual Testing

Test your changes in these scenarios:

- **Voice channels**: Different sizes (2-10+ users)
- **Audio quality**: Various microphone qualities
- **Network conditions**: Stable and unstable connections
- **Long sessions**: Recordings longer than 1 hour
- **Multiple formats**: Test all export formats (TXT, JSON, SRT, VTT)
- **Error conditions**: Invalid API keys, network failures, disk full

### Automated Testing

If adding tests:

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Run tests in watch mode
npm run test:watch
```

---

## Documentation

### Updating Documentation

Documentation is just as important as code:

- **README.md**: Main project overview and usage
- **INSTALL.md**: Installation instructions
- **CONTRIBUTING.md**: This file
- **Inline comments**: Explain complex logic
- **JSDoc**: Document functions and classes

### Documentation Style

- Use clear, concise language
- Include code examples where helpful
- Keep it up-to-date with code changes
- Use proper markdown formatting
- Add links to related sections

### Examples

Good documentation:
```markdown
### Setting the API Key

1. Go to **User Settings** → **Plugins** → **VoiceTranscriber**
2. Paste your API key in the **API Key** field
3. Click **Save**

**Note**: API keys are stored locally and never transmitted except to the transcription service.
```

---

## Commit Messages

Follow conventional commit format:

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

### Examples

```
feat(audio): add support for multiple audio formats

- Implement WAV export
- Add MP3 encoding
- Update settings UI

Closes #123
```

```
fix(transcription): handle API rate limits gracefully

Added retry logic with exponential backoff when hitting rate limits.
Shows user-friendly error message after max retries.

Fixes #456
```

---

## Getting Help

### Communication Channels

- **GitHub Issues**: Bug reports and feature requests
- **GitHub Discussions**: Questions and general discussion
- **Discord Server**: Real-time chat with community

### Asking Questions

When asking for help:

1. **Be specific**: Clearly describe what you need
2. **Show your work**: Share what you've tried
3. **Provide context**: Include relevant code and environment details
4. **Be patient**: Maintainers and contributors volunteer their time

---

## Recognition

Contributors are recognized in several ways:

- **Contributors list**: Added to README.md
- **Release notes**: Mentioned in version releases
- **GitHub profile**: Contributions appear on your profile
- **Community appreciation**: Thanked in discussions

---

## License

By contributing to VoiceTranscriber, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to VoiceTranscriber! Your efforts help make this project better for everyone. 🎙️
