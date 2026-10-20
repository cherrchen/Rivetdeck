// Windows data cleanup orchestration: history-driven protection, expected-inventory
// verification, and tiered removal on top of the safe-deletion primitives.
#pragma once
#include <algorithm>
#include <cwchar>
#include <cwctype>
#include <functional>
#include <string>
#include <vector>
#include "uninstall-data.h"

namespace uninstall_cleanup {

// One line per claim: `complete=0|1`, `userData=<path>`, `dshHome=<path>`. A missing file is
// absent history, never an error. Entries that cannot be normalized keep their claim
// unverifiable: damaged cleanup candidates forbid full removal, while an unresolvable
// protected root blocks every deletion that cannot be proven separate from it.
struct History {
    bool present = false;
    bool complete = false;
    bool damaged = false;
    bool unresolvableProtection = false;
    std::vector<std::wstring> userData;
    std::vector<std::wstring> homes;
};

inline std::wstring WideFromUtf8(const std::string& value) {
    if (value.empty()) return {};
    int size = MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (size <= 0) return {};
    std::wstring wide(static_cast<size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), &wide[0], size);
    return wide;
}

inline std::string Utf8FromWide(const std::wstring& value) {
    if (value.empty()) return {};
    int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0) return {};
    std::string utf8(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.data(), static_cast<int>(value.size()), &utf8[0], size, nullptr, nullptr);
    return utf8;
}

inline std::wstring Trim(std::wstring value) {
    const wchar_t* space = L" \t\r\n";
    const size_t begin = value.find_first_not_of(space);
    if (begin == std::wstring::npos) return {};
    const size_t end = value.find_last_not_of(space);
    return value.substr(begin, end - begin + 1);
}

inline DWORD ReadFileBytes(const std::wstring& path, std::string& bytes) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return GetLastError();
    LARGE_INTEGER size{};
    DWORD error = GetFileSizeEx(file, &size) ? ERROR_SUCCESS : GetLastError();
    if (error == ERROR_SUCCESS && size.QuadPart > 16 * 1024 * 1024) error = ERROR_FILE_TOO_LARGE;
    if (error == ERROR_SUCCESS) {
        bytes.resize(static_cast<size_t>(size.QuadPart));
        DWORD read = 0;
        if (!bytes.empty() && !ReadFile(file, &bytes[0], static_cast<DWORD>(bytes.size()), &read, nullptr))
            error = GetLastError();
        else
            bytes.resize(read);
    }
    CloseHandle(file);
    return error;
}

// Returns false when an entry fails to normalize; `normalized` stays empty for it.
inline bool NormalizeEntry(const std::wstring& raw, std::wstring& normalized) {
    if (raw.empty()) return false;
    return uninstall_data::Normalize(raw.c_str(), normalized);
}

inline DWORD LoadHistory(LPCWSTR file, History& history) {
    history = {};
    std::string bytes;
    DWORD error = ReadFileBytes(file, bytes);
    if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return ERROR_SUCCESS;
    if (error != ERROR_SUCCESS) {
        history.damaged = true;
        return error;
    }
    history.present = true;
    if (bytes.rfind("\xEF\xBB\xBF", 0) == 0) bytes.erase(0, 3);
    size_t offset = 0;
    while (offset <= bytes.size()) {
        const size_t newline = bytes.find('\n', offset);
        const std::string line = bytes.substr(offset, newline == std::string::npos ? newline : newline - offset);
        offset = newline == std::string::npos ? bytes.size() + 1 : newline + 1;
        const std::wstring wide = Trim(WideFromUtf8(line));
        if (wide.empty() || wide[0] == L'#' || wide[0] == L';') continue;
        const size_t equals = wide.find(L'=');
        // A malformed line or a key this reader does not know may hide a protection claim;
        // both are treated as unresolvable rather than merely damaged.
        if (equals == std::wstring::npos) {
            history.damaged = true;
            history.unresolvableProtection = true;
            continue;
        }
        const std::wstring key = Trim(wide.substr(0, equals));
        const std::wstring value = Trim(wide.substr(equals + 1));
        std::wstring normalized;
        if (_wcsicmp(key.c_str(), L"complete") == 0) {
            history.complete = value == L"1";
        } else if (_wcsicmp(key.c_str(), L"userData") == 0) {
            if (NormalizeEntry(value, normalized)) history.userData.push_back(normalized);
            else history.damaged = true;
        } else if (_wcsicmp(key.c_str(), L"dshHome") == 0) {
            if (NormalizeEntry(value, normalized)) history.homes.push_back(normalized);
            else history.unresolvableProtection = true;
        } else {
            history.unresolvableProtection = true;
        }
    }
    return ERROR_SUCCESS;
}

inline bool EqualPath(const std::wstring& left, const std::wstring& right) {
    return _wcsicmp(left.c_str(), right.c_str()) == 0;
}

inline bool ContainsPath(const std::vector<std::wstring>& paths, const std::wstring& path) {
    return std::any_of(paths.begin(), paths.end(), [&](const std::wstring& candidate) {
        return EqualPath(candidate, path);
    });
}

inline void PushUnique(std::vector<std::wstring>& paths, const std::wstring& path) {
    if (!ContainsPath(paths, path)) paths.push_back(path);
}

// Enumerates direct children of `root` and passes each to `visit`, which returns false to
// stop. Returns false when the directory cannot be listed; a missing root enumerates empty.
inline bool ForEachEntry(const std::wstring& root, const std::function<bool(const WIN32_FIND_DATAW&)>& visit) {
    WIN32_FIND_DATAW entry{};
    HANDLE search = FindFirstFileW((L"\\\\?\\" + root + L"\\*").c_str(), &entry);
    if (search == INVALID_HANDLE_VALUE) {
        const DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND;
    }
    bool ok = true;
    do {
        if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0) continue;
        if (!visit(entry)) {
            ok = false;
            break;
        }
    } while (FindNextFileW(search, &entry));
    const DWORD error = GetLastError();
    FindClose(search);
    return ok && error == ERROR_NO_MORE_FILES;
}

// Every entry must satisfy `visit`; reparse points always fail verification.
inline bool VerifyEntries(const std::wstring& root, const std::function<bool(const WIN32_FIND_DATAW&)>& visit) {
    return ForEachEntry(root, [&](const WIN32_FIND_DATAW& entry) {
        if (entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) return false;
        return visit(entry);
    });
}

inline bool IsDirectory(const WIN32_FIND_DATAW& entry) {
    return (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

inline bool NameEquals(const WIN32_FIND_DATAW& entry, const wchar_t* name) {
    return _wcsicmp(entry.cFileName, name) == 0;
}

inline bool IsVersionDirectory(const std::wstring& name) {
    // Runtime receipts live in `node/<semver>` and `python/<semver>` directories.
    if (name.empty() || !iswdigit(name.front()) || !iswdigit(name.back())) return false;
    int dots = 0;
    for (wchar_t ch : name) {
        if (ch == L'.') ++dots;
        else if (!iswdigit(ch)) return false;
    }
    return dots == 2;
}

inline bool IsTargetDirectory(const std::wstring& name) {
    const size_t dash = name.find(L'-');
    if (dash == std::wstring::npos) return false;
    const std::wstring os = name.substr(0, dash);
    const std::wstring arch = name.substr(dash + 1);
    const bool osOk = os == L"win32" || os == L"linux" || os == L"darwin";
    const bool archOk = arch == L"x64" || arch == L"arm64";
    return osOk && archOk;
}

inline bool IsGenerationDirectory(const std::wstring& name) {
    // Managed runtimes unpack into random-UUID generation directories.
    if (name.size() != 36) return false;
    for (size_t i = 0; i < name.size(); ++i) {
        const wchar_t ch = name[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (ch != L'-') return false;
        } else if (!iswxdigit(ch)) {
            return false;
        }
    }
    return true;
}

// `managed-toolchains` may contain only runtime receipts (`node`, `python`) and `staging`
// directories holding in-flight generations.
inline bool VerifyManagedToolchains(const std::wstring& root) {
    return VerifyEntries(root, [&](const WIN32_FIND_DATAW& entry) {
        if (!IsDirectory(entry)) return false;
        if (!NameEquals(entry, L"node") && !NameEquals(entry, L"python") && !NameEquals(entry, L"staging"))
            return false;
        const std::wstring runtime = root + L'\\' + entry.cFileName;
        if (NameEquals(entry, L"staging"))
            return VerifyEntries(runtime, [](const WIN32_FIND_DATAW& child) {
                return IsDirectory(child) && IsGenerationDirectory(child.cFileName);
            });
        return VerifyEntries(runtime, [&](const WIN32_FIND_DATAW& child) {
            if (!IsDirectory(child))
                return NameEquals(child, L"active.json") || NameEquals(child, L"installation.pending");
            if (!IsVersionDirectory(child.cFileName)) return false;
            const std::wstring version = runtime + L'\\' + child.cFileName;
            return VerifyEntries(version, [&](const WIN32_FIND_DATAW& target) {
                if (!IsDirectory(target) || !IsTargetDirectory(target.cFileName)) return false;
                const std::wstring platform = version + L'\\' + target.cFileName;
                return VerifyEntries(platform, [](const WIN32_FIND_DATAW& generation) {
                    return IsDirectory(generation) && IsGenerationDirectory(generation.cFileName);
                });
            });
        });
    });
}

// `electron/toolchains/bin` may contain only the generated command shims.
inline bool VerifyShimDirectory(const std::wstring& root) {
    static const wchar_t* shims[] = {
        L"python.cmd", L"python3.cmd", L"pip.cmd", L"pip3.cmd", L"npm.cmd", L"npx.cmd",
    };
    return VerifyEntries(root, [](const WIN32_FIND_DATAW& entry) {
        if (IsDirectory(entry)) return false;
        for (const wchar_t* shim : shims) if (NameEquals(entry, shim)) return true;
        return false;
    });
}

// The updater cache may contain only downloaded payloads, their staging directory, and
// the installer log directory.
inline bool VerifyUpdaterCache(const std::wstring& root) {
    static const wchar_t* extensions[] = {L".exe", L".7z", L".yml", L".yaml", L".json"};
    return VerifyEntries(root, [](const WIN32_FIND_DATAW& entry) {
        if (IsDirectory(entry))
            return NameEquals(entry, L"pending") || NameEquals(entry, L"installer-logs");
        const std::wstring name = entry.cFileName;
        const size_t dot = name.find_last_of(L'.');
        if (dot == std::wstring::npos) return false;
        for (const wchar_t* extension : extensions)
            if (_wcsicmp(name.c_str() + dot, extension) == 0) return true;
        return false;
    });
}

// A userData root is only ours when it carries a marker this product writes. Generic
// Chromium directories (Local State, Cache, Cookies, ...) are created by any Electron
// application and never prove ownership of a recorded root.
inline bool IsAttributedUserData(const std::wstring& root) {
    static const wchar_t* markers[] = {
        L"managed-toolchains", L"desktop-preferences.json",    L"electron-host.patch.yml",
        L"network-secrets",    L"network-startup-override.json",
    };
    for (const wchar_t* marker : markers) {
        const DWORD attributes = GetFileAttributesW((L"\\\\?\\" + root + L'\\' + marker).c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES) return true;
    }
    return false;
}

inline bool PathExists(const std::wstring& path) {
    return GetFileAttributesW((L"\\\\?\\" + path).c_str()) != INVALID_FILE_ATTRIBUTES;
}

// Reports are UTF-8 `skipped\t<path>\t<reason>` lines consumed by people and smoke tests.
inline DWORD WriteResidue(const std::wstring& reportPath, const std::vector<std::wstring>& entries) {
    if (entries.empty()) {
        if (DeleteFileW(reportPath.c_str())) return ERROR_SUCCESS;
        const DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? ERROR_SUCCESS : error;
    }
    std::string bytes;
    for (const std::wstring& entry : entries) {
        bytes += "skipped\t";
        bytes += Utf8FromWide(entry);
        bytes += "\r\n";
    }
    HANDLE file = CreateFileW(reportPath.c_str(), GENERIC_WRITE, 0, nullptr,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return GetLastError();
    DWORD written = 0;
    const BOOL ok = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr);
    const DWORD error = !ok ? GetLastError()
        : written == bytes.size() ? ERROR_SUCCESS : ERROR_WRITE_FAULT;
    CloseHandle(file);
    return error;
}

struct CleanupRequest {
    LPCWSTR userData = nullptr;
    LPCWSTR installation = nullptr;
    LPCWSTR protectedHome = nullptr;
    LPCWSTR historyFile = nullptr;
    LPCWSTR updaterCache = nullptr;
    LPCWSTR residueReport = nullptr;
    int deleteAppData = 0;
    int* removed = nullptr;
    int* residue = nullptr;
    // Independent report outcome: a cleanup error can coexist with a usable report.
    DWORD* reportError = nullptr;
};

struct CleanupState {
    std::vector<std::wstring> entries;
    std::vector<std::wstring> protection;
    uninstall_data::Handles protectedHandles;
    int removed = 0;
    DWORD firstError = ERROR_SUCCESS;

    void note(DWORD error) {
        if (error != ERROR_SUCCESS && firstError == ERROR_SUCCESS) firstError = error;
    }

    void skip(const std::wstring& path, const wchar_t* reason) {
        entries.push_back(path + L'\t' + reason);
    }

    bool protect(const std::wstring& path) {
        PushUnique(protection, path);
        std::wstring resolved;
        const DWORD error = uninstall_data::ResolveProtectionPath(path, resolved, protectedHandles);
        if (error) return false;
        PushUnique(protection, resolved);
        return true;
    }

    bool overlapsProtection(const std::wstring& path) const {
        for (const std::wstring& protectedPath : protection)
            if (uninstall_data::Contains(protectedPath, path) || uninstall_data::Contains(path, protectedPath))
                return true;
        return false;
    }

    // Removes one target through the pinned safe-deletion primitive; skips become residue.
    void remove(const std::wstring& path, const std::wstring& installation, const std::wstring& protectedHome) {
        if (overlapsProtection(path)) {
            skip(path, L"overlaps a protected path");
            return;
        }
        const DWORD error = uninstall_data::Remove(path.c_str(), installation.c_str(), protectedHome.c_str());
        if (error == ERROR_SUCCESS) ++removed;
        else {
            note(error);
            skip(path, L"removal failed");
        }
    }
};

// Cache names alone cannot exclude an unrecorded Harness home in legacy data.
// Without complete history each existing cache stays whole and is reported.
inline void RemoveNamedCaches(CleanupState& state, const std::wstring& root,
                              const std::wstring& installation, const std::wstring& protectedHome,
                              bool completeHistory) {
    static const wchar_t* caches[] = {
        L"Cache", L"Code Cache", L"GPUCache", L"DawnGraphiteCache", L"DawnWebGPUCache",
    };
    for (const wchar_t* cache : caches) {
        const std::wstring path = root + L'\\' + cache;
        if (!PathExists(path)) continue;
        if (completeHistory) state.remove(path, installation, protectedHome);
        else state.skip(path, L"cache isolation requires complete history");
    }
}

// Tiered cleanup of one userData root: rebuildable toolchains, command shims, and pure
// caches. Foreign or unverifiable targets are skipped whole and reported.
inline void CleanupUserDataTiered(CleanupState& state, const std::wstring& root,
                                  const std::wstring& installation, const std::wstring& protectedHome,
                                  bool completeHistory) {
    const std::wstring toolchains = root + L"\\managed-toolchains";
    if (PathExists(toolchains)) {
        if (!completeHistory) state.skip(toolchains, L"runtime isolation requires complete history");
        else if (VerifyManagedToolchains(toolchains)) state.remove(toolchains, installation, protectedHome);
        else state.skip(toolchains, L"unexpected content");
    }
    const std::wstring shims = root + L"\\electron\\toolchains\\bin";
    if (PathExists(shims)) {
        if (VerifyShimDirectory(shims)) {
            state.remove(shims, installation, protectedHome);
            // A parent that still holds residue ends the walk with ERROR_DIR_NOT_EMPTY;
            // that is the normal case, not a failure worth reporting.
            DWORD error = uninstall_data::RemoveEmptyParents(shims.c_str(), root.c_str());
            state.note(error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND
                || error == ERROR_DIR_NOT_EMPTY ? ERROR_SUCCESS : error);
        } else {
            state.skip(shims, L"unexpected content");
        }
    }
    RemoveNamedCaches(state, root, installation, protectedHome, completeHistory);
    // Session partitions hold non-cache browser data; only their pure cache directories
    // go. A partition tree that exists but cannot be listed leaves caches behind, so the
    // root itself lands in the residue report.
    const std::wstring partitions = root + L"\\Partitions";
    if (!ForEachEntry(partitions, [&](const WIN32_FIND_DATAW& entry) {
        if (!IsDirectory(entry) || (entry.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return true;
        RemoveNamedCaches(state, partitions + L'\\' + entry.cFileName, installation, protectedHome, completeHistory);
        return true;
    })) {
        state.skip(partitions, L"could not enumerate partition caches");
    }
}

inline DWORD Cleanup(const CleanupRequest& request) {
    CleanupState state;
    if (request.removed) *request.removed = 0;
    if (request.residue) *request.residue = 0;
    if (request.reportError) *request.reportError = ERROR_SUCCESS;

    std::wstring installation, userData, updaterCache, protectedHome, residueReport;
    if (!uninstall_data::Normalize(request.installation, installation))
        return ERROR_INVALID_NAME;
    const bool userDataOk = uninstall_data::Normalize(request.userData, userData);
    const bool updaterOk = uninstall_data::Normalize(request.updaterCache, updaterCache);
    const bool reportOk = uninstall_data::Normalize(request.residueReport, residueReport);

    History history;
    const DWORD historyError = LoadHistory(request.historyFile, history);

    // A protected root that fails to normalize cannot be reasoned about; refuse all
    // deletions rather than drop its protection claim.
    bool unresolvable = historyError != ERROR_SUCCESS || history.unresolvableProtection;
    if (request.protectedHome != nullptr && request.protectedHome[0] != L'\0') {
        if (!uninstall_data::Normalize(request.protectedHome, protectedHome))
            unresolvable = true;
        else if (!state.protect(protectedHome))
            unresolvable = true;
    }
    for (const std::wstring& home : history.homes)
        if (!state.protect(home)) unresolvable = true;

    std::vector<std::wstring> roots;
    if (userDataOk) PushUnique(roots, userData);
    for (const std::wstring& recorded : history.userData) PushUnique(roots, recorded);

    const bool completeHistory = history.present && history.complete && !history.damaged && !unresolvable;
    const bool mayRemoveAll = request.deleteAppData != 0 && completeHistory;

    if (unresolvable) {
        for (const std::wstring& root : roots)
            if (PathExists(root)) state.skip(root, L"a protected path could not be resolved");
        if (updaterOk && PathExists(updaterCache))
            state.skip(updaterCache, L"a protected path could not be resolved");
    } else {
        for (const std::wstring& root : roots) {
            if (!PathExists(root)) continue;
            if (!IsAttributedUserData(root)) {
                state.skip(root, L"not a recognized application data directory");
                continue;
            }
            if (request.deleteAppData != 0 && !mayRemoveAll)
                state.skip(root, L"complete history is missing or unproven");
            if (request.deleteAppData != 0 && mayRemoveAll) {
                state.remove(root, installation, protectedHome);
                continue;
            }
            CleanupUserDataTiered(state, root, installation, protectedHome, completeHistory);
        }
        if (updaterOk && PathExists(updaterCache)) {
            if (!completeHistory) state.skip(updaterCache, L"updater isolation requires complete history");
            else if (VerifyUpdaterCache(updaterCache)) state.remove(updaterCache, installation, protectedHome);
            else state.skip(updaterCache, L"unexpected content");
        }
    }

    const DWORD reportError = reportOk ? WriteResidue(residueReport, state.entries) : ERROR_INVALID_NAME;
    if (request.reportError) *request.reportError = reportError;
    state.note(reportError);
    if (request.removed) *request.removed = state.removed;
    if (request.residue) *request.residue = static_cast<int>(state.entries.size());
    if (!userDataOk || !updaterOk) state.note(ERROR_INVALID_NAME);
    return state.firstError;
}

} // namespace uninstall_cleanup
