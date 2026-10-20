// Native cleanup regressions operate only in the caller's private test directory.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#include <windows.h>
#include <stdlib.h>
#include <cassert>
#include "../installer/uninstall-data.h"

// Intercept only the orchestration's enumeration calls; safe removal uses Win32 directly.
static std::wstring enumerationFaultPattern;
static HANDLE enumerationFaultSearch = INVALID_HANDLE_VALUE;
static bool enumerationSawChild = false;
static bool IsChild(const WIN32_FIND_DATAW& entry) {
    return wcscmp(entry.cFileName, L".") != 0 && wcscmp(entry.cFileName, L"..") != 0;
}
static HANDLE WINAPI CleanupFindFirst(LPCWSTR pattern, LPWIN32_FIND_DATAW entry) {
    HANDLE search = FindFirstFileW(pattern, entry);
    if (search != INVALID_HANDLE_VALUE && enumerationFaultPattern == pattern) {
        enumerationFaultSearch = search;
        enumerationSawChild = IsChild(*entry);
    }
    return search;
}
static BOOL WINAPI CleanupFindNext(HANDLE search, LPWIN32_FIND_DATAW entry) {
    if (search == enumerationFaultSearch && enumerationSawChild) {
        SetLastError(ERROR_READ_FAULT);
        return FALSE;
    }
    const BOOL result = FindNextFileW(search, entry);
    if (result && search == enumerationFaultSearch) enumerationSawChild = IsChild(*entry);
    return result;
}
static BOOL WINAPI CleanupFindClose(HANDLE search) {
    if (search == enumerationFaultSearch) enumerationFaultSearch = INVALID_HANDLE_VALUE;
    const BOOL result = FindClose(search);
    // Closing a handle must not overwrite the enumeration outcome under test.
    SetLastError(ERROR_SUCCESS);
    return result;
}
static bool shortReportWrite = false;
static BOOL WINAPI CleanupWriteFile(HANDLE file, LPCVOID bytes, DWORD size, LPDWORD written, LPOVERLAPPED overlapped) {
    if (shortReportWrite && size > 0) {
        *written = size - 1;
        return TRUE;
    }
    return WriteFile(file, bytes, size, written, overlapped);
}
#define FindFirstFileW CleanupFindFirst
#define FindNextFileW CleanupFindNext
#define FindClose CleanupFindClose
#define WriteFile CleanupWriteFile
#include "../installer/uninstall-cleanup.h"
#undef FindFirstFileW
#undef FindNextFileW
#undef FindClose
#undef WriteFile

static void File(const std::wstring& path, DWORD attributes = FILE_ATTRIBUTE_NORMAL) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, attributes, nullptr);
    assert(file != INVALID_HANDLE_VALUE);
    DWORD count;
    assert(WriteFile(file, "retained", 8, &count, nullptr));
    CloseHandle(file);
}

static void WriteText(const std::wstring& path, const std::string& text) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    assert(file != INVALID_HANDLE_VALUE);
    DWORD count;
    assert(WriteFile(file, text.data(), static_cast<DWORD>(text.size()), &count, nullptr));
    CloseHandle(file);
}

static void Mkdir(const std::wstring& path) { assert(CreateDirectoryW(path.c_str(), nullptr)); }

static bool Exists(const std::wstring& path) { return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES; }

// Best-effort recursive delete for the test's own scratch tree; reparse points are
// unlinked rather than descended, matching the safety rules under test.
static void RemoveAll(const std::wstring& path) {
    WIN32_FIND_DATAW entry{};
    HANDLE search = FindFirstFileW((path + L"\\*").c_str(), &entry);
    if (search != INVALID_HANDLE_VALUE) {
        do {
            if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0) continue;
            const std::wstring child = path + L'\\' + entry.cFileName;
            const DWORD attributes = entry.dwFileAttributes;
            if ((attributes & FILE_ATTRIBUTE_DIRECTORY) && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT)) RemoveAll(child);
            else if (attributes & FILE_ATTRIBUTE_DIRECTORY) RemoveDirectoryW(child.c_str());
            else DeleteFileW(child.c_str());
        } while (FindNextFileW(search, &entry));
        FindClose(search);
    }
    RemoveDirectoryW(path.c_str());
}

// History lines are written as narrow text; test paths are ASCII.
static std::string Narrow(const std::wstring& wide) {
    std::string narrow;
    narrow.reserve(wide.size());
    for (wchar_t ch : wide) narrow += static_cast<char>(ch);
    return narrow;
}

// A directory junction lets a link sit where a real directory is expected; cleanup must
// unlink the junction root and never descend into the target. mklink /J needs no elevation.
static bool MakeJunction(const std::wstring& link, const std::wstring& target) {
    return _wsystem((L"cmd /c mklink /J \"" + link + L"\" \"" + target + L"\" >NUL 2>NUL").c_str()) == 0;
}

// Builds the managed-toolchains receipt tree the app produces.
static void SeedToolchains(const std::wstring& root) {
    const std::wstring node = root + L"\\node\\24.5.0\\win32-x64\\3f8a1c2e-0000-4abc-9def-0123456789ab";
    Mkdir(root + L"\\node");
    Mkdir(root + L"\\node\\24.5.0");
    Mkdir(root + L"\\node\\24.5.0\\win32-x64");
    Mkdir(node);
    File(root + L"\\node\\active.json");
    File(node + L"\\node.exe");
    const std::wstring staging = root + L"\\staging\\8c4d2f10-1111-4bcd-8f0a-abcdef012345";
    Mkdir(root + L"\\staging");
    Mkdir(staging);
    File(staging + L"\\package.7z");
}

int wmain(int argc, wchar_t** argv) {
    assert(argc == 2);
    const std::wstring root = argv[1];
    const std::wstring installation = root + L"\\application";
    const std::wstring data = root + L"\\data";
    const std::wstring cache = data + L"\\Local Storage\\leveldb";
    Mkdir(root);
    Mkdir(installation);
    Mkdir(data);
    Mkdir(data + L"\\Local Storage");
    Mkdir(cache);
    File(data + L"\\Local State");
    File(cache + L"\\CURRENT");
    File(cache + L"\\LOCK", FILE_ATTRIBUTE_READONLY);
    File(cache + L"\\MANIFEST");

    // Refused roots: the test root contains the installation; shell roots and malformed paths are rejected.
    assert(uninstall_data::Remove(root.c_str(), installation.c_str(), nullptr) == ERROR_ACCESS_DENIED);
    assert(uninstall_data::Remove(L"C:\\", installation.c_str(), nullptr) == ERROR_INVALID_NAME);
    assert(uninstall_data::Remove(L"relative", installation.c_str(), nullptr) == ERROR_INVALID_NAME);
    assert(uninstall_data::Remove(L"C:\\bad*", installation.c_str(), nullptr) == ERROR_INVALID_NAME);
    PWSTR profile = nullptr;
    assert(SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &profile)));
    assert(uninstall_data::Remove(profile, installation.c_str(), nullptr) == ERROR_ACCESS_DENIED);
    CoTaskMemFree(profile);

    // A protected root overlapping the target in either direction, or an unusable one, stops removal.
    assert(uninstall_data::Remove(cache.c_str(), installation.c_str(), data.c_str()) == ERROR_ACCESS_DENIED);
    assert(uninstall_data::Remove(data.c_str(), installation.c_str(), cache.c_str()) == ERROR_ACCESS_DENIED);
    assert(uninstall_data::Remove(cache.c_str(), installation.c_str(), L"relative\\home") == ERROR_INVALID_NAME);
    assert(Exists(cache + L"\\CURRENT"));

    // A pinned directory cannot be renamed or replaced while the helper holds it.
    {
        uninstall_data::Handles pinned;
        assert(uninstall_data::Pin(cache, pinned) == ERROR_SUCCESS);
        assert(!MoveFileExW(cache.c_str(), (data + L"\\renamed").c_str(), 0));
        assert(GetLastError() == ERROR_SHARING_VIOLATION || GetLastError() == ERROR_ACCESS_DENIED);
    }
    assert(Exists(cache));

    // A locked file returns its error but every sibling, including a read-only one, is still removed.
    HANDLE held = CreateFileW((cache + L"\\CURRENT").c_str(), GENERIC_READ, FILE_SHARE_READ,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    assert(held != INVALID_HANDLE_VALUE);
    assert(uninstall_data::Remove(cache.c_str(), installation.c_str(), nullptr) == ERROR_SHARING_VIOLATION);
    assert(Exists(cache + L"\\CURRENT"));
    assert(!Exists(cache + L"\\LOCK"));
    assert(!Exists(cache + L"\\MANIFEST"));
    CloseHandle(held);
    assert(uninstall_data::Remove(cache.c_str(), installation.c_str(), nullptr) == ERROR_SUCCESS);
    assert(Exists(data + L"\\Local State"));
    assert(uninstall_data::Remove(cache.c_str(), installation.c_str(), nullptr) == ERROR_SUCCESS);

    // Empty ordinary parents below the stop directory are removed; the stop directory and populated parents stay.
    const std::wstring scope = root + L"\\@scope";
    const std::wstring package = scope + L"\\package";
    Mkdir(scope);
    Mkdir(package);
    assert(uninstall_data::RemoveEmptyParents(package.c_str(), root.c_str()) == ERROR_DIR_NOT_EMPTY);
    assert(Exists(scope));
    assert(RemoveDirectoryW(package.c_str()));
    assert(uninstall_data::RemoveEmptyParents(root.c_str(), root.c_str()) == ERROR_ACCESS_DENIED);
    assert(uninstall_data::RemoveEmptyParents(package.c_str(), root.c_str()) == ERROR_SUCCESS);
    assert(!Exists(scope));
    assert(Exists(root));

    // A protected root elsewhere does not block removal.
    assert(uninstall_data::Remove(data.c_str(), installation.c_str(), (root + L"\\elsewhere").c_str()) == ERROR_SUCCESS);
    assert(!Exists(data));

    // --- Orchestration: history parsing, inventory verification, tiered cleanup ---

    // Missing history file parses as absent, not an error.
    {
        uninstall_cleanup::History history;
        assert(uninstall_cleanup::LoadHistory((root + L"\\missing.ini").c_str(), history) == ERROR_SUCCESS);
        assert(!history.present && !history.complete);
    }

    // complete + userData + dshHome lines merge into typed claims.
    const std::wstring userData = root + L"\\Rivetdeck";
    const std::wstring home = root + L"\\dsh-home";
    Mkdir(userData);
    Mkdir(home);
    const std::wstring historyPath = root + L"\\history.ini";
    WriteText(historyPath, "complete=1\r\nuserData=" + Narrow(userData) +
        "\r\ndshHome=" + Narrow(home) + "\r\n");
    {
        uninstall_cleanup::History history;
        assert(uninstall_cleanup::LoadHistory(historyPath.c_str(), history) == ERROR_SUCCESS);
        assert(history.present && history.complete && !history.damaged);
        assert(history.userData.size() == 1u && history.homes.size() == 1u);
    }

    // An unnormalizable dshHome claim is unresolvable protection, not dropped history.
    const std::wstring damagedHistory = root + L"\\damaged.ini";
    WriteText(damagedHistory, "complete=1\r\ndshHome=relative\\path\r\n");
    {
        uninstall_cleanup::History history;
        assert(uninstall_cleanup::LoadHistory(damagedHistory.c_str(), history) == ERROR_SUCCESS);
        assert(history.unresolvableProtection);
    }

    // An unknown record key may hide a protection claim; cleanup refuses every target.
    const std::wstring unknownKeyHistory = root + L"\\unknown-key.ini";
    WriteText(unknownKeyHistory, "complete=1\r\nfutureHome=Z:\\elsewhere\r\n");
    const std::wstring blocked = root + L"\\blocked-userdata";
    Mkdir(blocked);
    File(blocked + L"\\Local State");
    {
        uninstall_cleanup::History history;
        assert(uninstall_cleanup::LoadHistory(unknownKeyHistory.c_str(), history) == ERROR_SUCCESS);
        assert(history.unresolvableProtection);
        const std::wstring noUpdater = root + L"\\no-updater";
        const std::wstring blockedReport = root + L"\\blocked-residue.log";
        uninstall_cleanup::CleanupRequest request;
        request.userData = blocked.c_str();
        request.installation = installation.c_str();
        request.protectedHome = L"";
        request.historyFile = unknownKeyHistory.c_str();
        request.updaterCache = noUpdater.c_str();
        request.residueReport = blockedReport.c_str();
        int residue = 0;
        request.residue = &residue;
        uninstall_cleanup::Cleanup(request);
        assert(Exists(blocked));
        assert(residue > 0);
    }

    // Inventory verification: receipt tree passes; a foreign entry fails the whole target.
    const std::wstring toolchains = userData + L"\\managed-toolchains";
    Mkdir(toolchains);
    SeedToolchains(toolchains);
    assert(uninstall_cleanup::VerifyManagedToolchains(toolchains));
    File(toolchains + L"\\strange.txt");
    assert(!uninstall_cleanup::VerifyManagedToolchains(toolchains));
    assert(DeleteFileW((toolchains + L"\\strange.txt").c_str()));

    // Shim directory: known shims pass, unknown entries fail.
    const std::wstring shims = userData + L"\\electron\\toolchains\\bin";
    Mkdir(userData + L"\\electron");
    Mkdir(userData + L"\\electron\\toolchains");
    Mkdir(shims);
    File(shims + L"\\python.cmd");
    File(shims + L"\\npm.cmd");
    assert(uninstall_cleanup::VerifyShimDirectory(shims));
    File(shims + L"\\evil.exe");
    assert(!uninstall_cleanup::VerifyShimDirectory(shims));
    assert(DeleteFileW((shims + L"\\evil.exe").c_str()));

    // Attribution: generic Chromium directories are not ownership; a marker this product
    // writes is required before a recorded root becomes a cleanup candidate.
    const std::wstring attributed = root + L"\\attributed-root";
    Mkdir(attributed);
    File(attributed + L"\\Local State");
    File(attributed + L"\\Cookies");
    assert(!uninstall_cleanup::IsAttributedUserData(attributed));
    File(attributed + L"\\desktop-preferences.json");
    assert(uninstall_cleanup::IsAttributedUserData(attributed));
    const std::wstring bare = root + L"\\bare-root";
    Mkdir(bare);
    assert(!uninstall_cleanup::IsAttributedUserData(bare));
    File(userData + L"\\Local State");

    // Tiered cleanup (no delete flag): rebuildables removed, preferences and browser data kept.
    const std::wstring cacheDir = userData + L"\\Cache";
    const std::wstring partitionCache = userData + L"\\Partitions\\worker_1\\GPUCache";
    const std::wstring dawnCache = userData + L"\\DawnWebGPUCache";
    const std::wstring partitionDawn = userData + L"\\Partitions\\worker_1\\DawnGraphiteCache";
    const std::wstring partitionData = userData + L"\\Partitions\\worker_1\\IndexedDB";
    const std::wstring updater = root + L"\\rivetdeck-updater";
    const std::wstring report = root + L"\\residue.log";
    Mkdir(cacheDir);
    File(cacheDir + L"\\data_0");
    Mkdir(userData + L"\\Partitions");
    Mkdir(userData + L"\\Partitions\\worker_1");
    Mkdir(partitionCache);
    File(partitionCache + L"\\gpu.bin");
    Mkdir(dawnCache);
    File(dawnCache + L"\\dawn.bin");
    Mkdir(partitionDawn);
    File(partitionDawn + L"\\dawn.bin");
    Mkdir(partitionData);
    File(partitionData + L"\\db.leveldb");
    File(userData + L"\\desktop-preferences.json");
    File(userData + L"\\Cookies");
    // A foreign file beside the shim directory keeps its parents non-empty; removing
    // empty parents then stops on ordinary residue, which must not fail the cleanup.
    File(userData + L"\\electron\\toolchains\\keep.txt");
    Mkdir(updater);
    File(updater + L"\\installer.exe");
    Mkdir(updater + L"\\pending");
    {
        uninstall_cleanup::CleanupRequest request;
        request.userData = userData.c_str();
        request.installation = installation.c_str();
        request.protectedHome = L"";
        request.historyFile = historyPath.c_str();
        request.updaterCache = updater.c_str();
        request.residueReport = report.c_str();
        int removed = 0, residue = 0;
        request.removed = &removed;
        request.residue = &residue;
        assert(uninstall_cleanup::Cleanup(request) == ERROR_SUCCESS);
        assert(!Exists(toolchains));
        assert(!Exists(shims));
        assert(Exists(userData + L"\\electron\\toolchains\\keep.txt"));
        assert(!Exists(cacheDir));
        assert(!Exists(partitionCache));
        assert(!Exists(dawnCache));
        assert(!Exists(partitionDawn));
        assert(!Exists(updater));
        assert(Exists(userData + L"\\desktop-preferences.json"));
        assert(Exists(userData + L"\\Cookies"));
        assert(Exists(partitionData + L"\\db.leveldb"));
        assert(Exists(userData + L"\\Local State"));
        assert(residue == 0);
    }

    // A protected path overlapping a candidate skips it whole and reports residue.
    {
        uninstall_cleanup::CleanupRequest request;
        request.userData = home.c_str();  // recorded home overlapping protection
        request.installation = installation.c_str();
        request.protectedHome = home.c_str();
        request.historyFile = historyPath.c_str();
        request.updaterCache = updater.c_str();
        request.residueReport = report.c_str();
        request.deleteAppData = 1;
        int residue = 0;
        request.residue = &residue;
        uninstall_cleanup::Cleanup(request);
        assert(Exists(home));
        assert(residue > 0);
        assert(Exists(report));
    }

    // deleteAppData without proven completeness skips the root and reports residue.
    const std::wstring userData2 = root + L"\\Rivetdeck2";
    Mkdir(userData2);
    File(userData2 + L"\\Local State");
    File(userData2 + L"\\desktop-preferences.json");
    const std::wstring incompleteHistory = root + L"\\incomplete.ini";
    WriteText(incompleteHistory, "complete=0\r\nuserData=" + Narrow(userData2) + "\r\n");
    {
        uninstall_cleanup::CleanupRequest request;
        request.userData = userData2.c_str();
        request.installation = installation.c_str();
        request.protectedHome = L"";
        request.historyFile = incompleteHistory.c_str();
        request.updaterCache = updater.c_str();
        request.residueReport = report.c_str();
        request.deleteAppData = 1;
        int residue = 0;
        request.residue = &residue;
        uninstall_cleanup::Cleanup(request);
        assert(Exists(userData2));
        assert(residue > 0);
    }

    // deleteAppData with complete history removes the entire attributed root.
    const std::wstring fullHistory = root + L"\\full.ini";
    WriteText(fullHistory, "complete=1\r\nuserData=" + Narrow(userData2) + "\r\n");
    {
        uninstall_cleanup::CleanupRequest request;
        request.userData = userData2.c_str();
        request.installation = installation.c_str();
        request.protectedHome = L"";
        request.historyFile = fullHistory.c_str();
        request.updaterCache = updater.c_str();
        request.residueReport = report.c_str();
        request.deleteAppData = 1;
        assert(uninstall_cleanup::Cleanup(request) == ERROR_SUCCESS);
        assert(!Exists(userData2));
    }

    // A junction inside a cache target is unlinked only; the junction target survives.
    const std::wstring userData3 = root + L"\\Rivetdeck3";
    const std::wstring junctionTarget = root + L"\\elsewhere-target";
    Mkdir(userData3);
    File(userData3 + L"\\Local State");
    File(userData3 + L"\\desktop-preferences.json");
    const std::wstring cache3 = userData3 + L"\\Cache";
    Mkdir(cache3);
    Mkdir(junctionTarget);
    File(junctionTarget + L"\\keep.me");
    assert(MakeJunction(cache3 + L"\\linked", junctionTarget));
    {
        const std::wstring cacheHistory = root + L"\\cache-history.ini";
        WriteText(cacheHistory, "complete=1\r\n");
        uninstall_cleanup::CleanupRequest request;
        request.userData = userData3.c_str();
        request.installation = installation.c_str();
        request.protectedHome = L"";
        request.historyFile = cacheHistory.c_str();
        request.updaterCache = updater.c_str();
        request.residueReport = report.c_str();
        assert(uninstall_cleanup::Cleanup(request) == ERROR_SUCCESS);
        assert(!Exists(cache3));
        assert(Exists(junctionTarget + L"\\keep.me"));
    }

    // A recorded root carrying only generic Chromium entries may have been reused by
    // another Electron application; it is reported, never tiered or purged.
    const std::wstring foreign = root + L"\\reused-root";
    Mkdir(foreign);
    File(foreign + L"\\Local State");
    File(foreign + L"\\Cookies");
    Mkdir(foreign + L"\\Cache");
    File(foreign + L"\\Cache\\data_0");
    Mkdir(foreign + L"\\Partitions");
    Mkdir(foreign + L"\\Partitions\\worker");
    Mkdir(foreign + L"\\Partitions\\worker\\GPUCache");
    File(foreign + L"\\Partitions\\worker\\GPUCache\\gpu.bin");
    const std::wstring foreignHistory = root + L"\\foreign.ini";
    WriteText(foreignHistory, "complete=1\r\nuserData=" + Narrow(foreign) + "\r\n");
    for (int purge : {0, 1}) {
        uninstall_cleanup::CleanupRequest request;
        request.userData = foreign.c_str();
        request.installation = installation.c_str();
        request.protectedHome = L"";
        request.historyFile = foreignHistory.c_str();
        request.updaterCache = updater.c_str();
        request.residueReport = report.c_str();
        request.deleteAppData = purge;
        int residue = 0;
        request.residue = &residue;
        assert(uninstall_cleanup::Cleanup(request) == ERROR_SUCCESS);
        assert(Exists(foreign + L"\\Cache\\data_0"));
        assert(Exists(foreign + L"\\Partitions\\worker\\GPUCache\\gpu.bin"));
        assert(residue > 0);
    }

    // Legacy history cannot exclude a Harness home inside a cache, even without a purge flag.
    for (bool missingHistory : {false, true}) {
        for (int purge : {0, 1}) {
            const std::wstring legacy = root + L"\\legacy-" + (missingHistory ? L"missing-" : L"incomplete-")
                + std::to_wstring(purge);
            Mkdir(legacy);
            File(legacy + L"\\Local State");
            Mkdir(legacy + L"\\Cache");
            Mkdir(legacy + L"\\Cache\\shared-home");
            File(legacy + L"\\Cache\\shared-home\\sessions.jsonl");
            Mkdir(legacy + L"\\Partitions");
            Mkdir(legacy + L"\\Partitions\\worker");
            Mkdir(legacy + L"\\Partitions\\worker\\GPUCache");
            File(legacy + L"\\Partitions\\worker\\GPUCache\\.credentials.yaml");
            Mkdir(legacy + L"\\managed-toolchains");
            SeedToolchains(legacy + L"\\managed-toolchains");
            const std::wstring generationHome = legacy
                + L"\\managed-toolchains\\node\\24.5.0\\win32-x64\\3f8a1c2e-0000-4abc-9def-0123456789ab\\home";
            const std::wstring stagingHome = legacy
                + L"\\managed-toolchains\\staging\\8c4d2f10-1111-4bcd-8f0a-abcdef012345\\home";
            Mkdir(generationHome);
            File(generationHome + L"\\.credentials.yaml");
            Mkdir(stagingHome);
            File(stagingHome + L"\\sessions.jsonl");
            const std::wstring legacyUpdater = legacy + L"\\updater";
            Mkdir(legacyUpdater);
            Mkdir(legacyUpdater + L"\\pending");
            Mkdir(legacyUpdater + L"\\pending\\home");
            File(legacyUpdater + L"\\pending\\home\\sessions.jsonl");
            Mkdir(legacyUpdater + L"\\installer-logs");
            File(legacyUpdater + L"\\installer-logs\\.credentials.yaml");
            const std::wstring record = legacy + L"\\history.ini";
            if (!missingHistory) WriteText(record, "complete=0\r\n");
            uninstall_cleanup::CleanupRequest request;
            request.userData = legacy.c_str();
            request.installation = installation.c_str();
            request.historyFile = record.c_str();
            request.updaterCache = legacyUpdater.c_str();
            request.residueReport = report.c_str();
            request.deleteAppData = purge;
            int residue = 0;
            request.residue = &residue;
            assert(uninstall_cleanup::Cleanup(request) == ERROR_SUCCESS);
            assert(Exists(legacy + L"\\Cache\\shared-home\\sessions.jsonl"));
            assert(Exists(legacy + L"\\Partitions\\worker\\GPUCache\\.credentials.yaml"));
            assert(Exists(generationHome + L"\\.credentials.yaml"));
            assert(Exists(stagingHome + L"\\sessions.jsonl"));
            assert(Exists(legacyUpdater + L"\\pending\\home\\sessions.jsonl"));
            assert(Exists(legacyUpdater + L"\\installer-logs\\.credentials.yaml"));
            std::string reportBytes;
            assert(uninstall_cleanup::ReadFileBytes(report, reportBytes) == ERROR_SUCCESS);
            assert(reportBytes.find(Narrow(legacyUpdater)) != std::string::npos);
            assert(reportBytes.find(Narrow(legacy + L"\\managed-toolchains")) != std::string::npos);
            assert(residue >= 4);
        }
    }

    // Protection may enter a real deletion directory through a junction outside it.
    const std::wstring aliasData = root + L"\\alias-data";
    const std::wstring aliasHome = aliasData + L"\\Cache\\shared-home";
    const std::wstring homeAlias = root + L"\\home-alias";
    const std::wstring aliasHistory = root + L"\\alias-history.ini";
    Mkdir(aliasData);
    File(aliasData + L"\\Local State");
    File(aliasData + L"\\desktop-preferences.json");
    Mkdir(aliasData + L"\\Cache");
    Mkdir(aliasHome);
    File(aliasHome + L"\\sessions.jsonl");
    assert(MakeJunction(homeAlias, aliasHome));
    assert(uninstall_data::Remove((aliasData + L"\\Cache").c_str(), installation.c_str(), homeAlias.c_str())
        == ERROR_ACCESS_DENIED);
    {
        uninstall_data::Handles handles;
        std::wstring resolved;
        assert(uninstall_data::ResolveProtectionPath(homeAlias + L"\\missing\\child", resolved, handles) == ERROR_SUCCESS);
        assert(uninstall_cleanup::EqualPath(resolved, aliasHome + L"\\missing\\child"));
    }
    for (bool recordedHome : {false, true}) {
        for (int purge : {0, 1}) {
            WriteText(aliasHistory, "complete=1\r\n" + (recordedHome
                ? "dshHome=" + Narrow(homeAlias) + "\r\n" : std::string()));
            uninstall_cleanup::CleanupRequest request;
            request.userData = aliasData.c_str();
            request.installation = installation.c_str();
            request.protectedHome = recordedHome ? L"" : homeAlias.c_str();
            request.historyFile = aliasHistory.c_str();
            request.updaterCache = updater.c_str();
            request.residueReport = report.c_str();
            request.deleteAppData = purge;
            int residue = 0;
            request.residue = &residue;
            assert(uninstall_cleanup::Cleanup(request) == ERROR_SUCCESS);
            assert(Exists(aliasHome + L"\\sessions.jsonl"));
            assert(residue > 0);
        }
    }

    const std::wstring brokenTarget = root + L"\\removed-home";
    const std::wstring brokenAlias = root + L"\\broken-alias";
    Mkdir(brokenTarget);
    assert(MakeJunction(brokenAlias, brokenTarget));
    assert(RemoveDirectoryW(brokenTarget.c_str()));
    WriteText(aliasHistory, "complete=1\r\ndshHome=" + Narrow(brokenAlias) + "\r\n");
    {
        uninstall_cleanup::CleanupRequest request;
        request.userData = aliasData.c_str();
        request.installation = installation.c_str();
        request.historyFile = aliasHistory.c_str();
        request.updaterCache = updater.c_str();
        request.residueReport = report.c_str();
        request.deleteAppData = 1;
        int residue = 0;
        request.residue = &residue;
        assert(uninstall_cleanup::Cleanup(request) == ERROR_SUCCESS);
        assert(Exists(aliasHome + L"\\sessions.jsonl"));
        assert(residue > 0);
    }

    // An I/O failure after a real child is observed cannot verify a partial inventory.
    const std::wstring enumerationData = root + L"\\enumeration-data";
    const std::wstring enumerationShims = enumerationData + L"\\electron\\toolchains\\bin";
    const std::wstring enumerationPartitions = enumerationData + L"\\Partitions";
    Mkdir(enumerationData);
    File(enumerationData + L"\\Local State");
    File(enumerationData + L"\\desktop-preferences.json");
    Mkdir(enumerationData + L"\\electron");
    Mkdir(enumerationData + L"\\electron\\toolchains");
    Mkdir(enumerationShims);
    File(enumerationShims + L"\\python.cmd");
    File(enumerationShims + L"\\npm.cmd");
    Mkdir(enumerationPartitions);
    Mkdir(enumerationPartitions + L"\\first");
    Mkdir(enumerationPartitions + L"\\second");
    {
        uninstall_cleanup::CleanupRequest request;
        request.userData = enumerationData.c_str();
        request.installation = installation.c_str();
        request.historyFile = fullHistory.c_str();
        request.updaterCache = updater.c_str();
        request.residueReport = report.c_str();
        for (const std::wstring& target : {enumerationShims, enumerationPartitions}) {
            enumerationFaultPattern = L"\\\\?\\" + target + L"\\*";
            int visited = 0;
            assert(!uninstall_cleanup::ForEachEntry(target, [&](const WIN32_FIND_DATAW&) {
                ++visited;
                return true;
            }));
            assert(visited == 1);
            int residue = 0;
            request.residue = &residue;
            assert(uninstall_cleanup::Cleanup(request) == ERROR_SUCCESS);
            assert(Exists(target));
            std::string bytes;
            assert(uninstall_cleanup::ReadFileBytes(report, bytes) == ERROR_SUCCESS);
            assert(bytes.find(Narrow(target)) != std::string::npos);
            assert(residue > 0);
            if (target == enumerationShims) assert(Exists(enumerationShims + L"\\python.cmd"));
        }
        enumerationFaultPattern.clear();
    }

    // Report failure is independent of the skipped-target count; no stale report is usable.
    {
        WriteText(report, "old report");
        HANDLE lockedReport = CreateFileW(report.c_str(), GENERIC_READ, FILE_SHARE_READ,
            nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        assert(lockedReport != INVALID_HANDLE_VALUE);
        uninstall_cleanup::CleanupRequest request;
        request.userData = enumerationData.c_str();
        request.installation = installation.c_str();
        request.historyFile = incompleteHistory.c_str();
        request.updaterCache = updater.c_str();
        request.residueReport = report.c_str();
        request.deleteAppData = 1;
        DWORD reportError = ERROR_SUCCESS;
        int residue = 0, removed = 0;
        request.residue = &residue;
        request.removed = &removed;
        request.reportError = &reportError;
        assert(uninstall_cleanup::Cleanup(request) == ERROR_SHARING_VIOLATION);
        assert(reportError == ERROR_SHARING_VIOLATION && residue > 0);
        assert(uninstall_cleanup::WriteResidue(report, {}) == ERROR_SHARING_VIOLATION);
        CloseHandle(lockedReport);
        shortReportWrite = true;
        assert(uninstall_cleanup::Cleanup(request) == ERROR_WRITE_FAULT);
        assert(reportError == ERROR_WRITE_FAULT && residue > 0);
        shortReportWrite = false;
        request.residueReport = L"relative-report.log";
        assert(uninstall_cleanup::Cleanup(request) == ERROR_INVALID_NAME);
        assert(reportError == ERROR_INVALID_NAME);
        request.installation = L"relative-installation";
        assert(uninstall_cleanup::Cleanup(request) == ERROR_INVALID_NAME);
        assert(residue == 0 && removed == 0);
        assert(Exists(enumerationData + L"\\Local State"));
    }

    assert(RemoveDirectoryW(installation.c_str()));

    RemoveAll(root);
    assert(!Exists(root));
}
