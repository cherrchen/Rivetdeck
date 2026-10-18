// Native cleanup regressions operate only in the caller's private test directory.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#include <windows.h>
#include <winioctl.h>
#include <cassert>
#include "../installer/uninstall-data.h"
#include "../installer/uninstall-cleanup.h"

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

// History lines are written as narrow text; test paths are ASCII.
static std::string Narrow(const std::wstring& wide) {
    std::string narrow;
    narrow.reserve(wide.size());
    for (wchar_t ch : wide) narrow += static_cast<char>(ch);
    return narrow;
}

// A directory junction lets a link sit where a real directory is expected; cleanup must
// unlink the junction root and never descend into the target.
static bool MakeJunction(const std::wstring& link, const std::wstring& target) {
    if (!CreateDirectoryW(link.c_str(), nullptr)) return false;
    HANDLE handle = CreateFileW(link.c_str(), GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE) return false;
    char buffer[2048]{};
    REPARSE_DATA_BUFFER* reparse = reinterpret_cast<REPARSE_DATA_BUFFER*>(buffer);
    reparse->ReparseTag = IO_REPARSE_TAG_MOUNT_POINT;
    const std::wstring substitute = L"\\??\\" + target;
    const size_t substituteBytes = substitute.size() * sizeof(wchar_t);
    const size_t printBytes = target.size() * sizeof(wchar_t);
    reparse->MountPointReparseBuffer.SubstituteNameOffset = 0;
    reparse->MountPointReparseBuffer.SubstituteNameLength = static_cast<USHORT>(substituteBytes);
    reparse->MountPointReparseBuffer.PrintNameOffset = static_cast<USHORT>(substituteBytes + sizeof(wchar_t));
    reparse->MountPointReparseBuffer.PrintNameLength = static_cast<USHORT>(printBytes);
    memcpy(reparse->MountPointReparseBuffer.PathBuffer, substitute.c_str(), substituteBytes + sizeof(wchar_t));
    memcpy(reinterpret_cast<char*>(reparse->MountPointReparseBuffer.PathBuffer) + substituteBytes + sizeof(wchar_t),
           target.c_str(), printBytes + sizeof(wchar_t));
    reparse->ReparseDataLength = static_cast<USHORT>(substituteBytes + printBytes + 12);
    DWORD returned = 0;
    const BOOL ok = DeviceIoControl(handle, FSCTL_SET_REPARSE_POINT, reparse,
        reparse->ReparseDataLength + REPARSE_GUID_DATA_BUFFER_HEADER_SIZE, nullptr, 0, &returned, nullptr);
    CloseHandle(handle);
    return ok == TRUE;
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

    // Attribution: a root with product markers is ours; a bare root is not.
    File(userData + L"\\Local State");
    assert(uninstall_cleanup::IsAttributedUserData(userData));
    const std::wstring bare = root + L"\\bare-root";
    Mkdir(bare);
    assert(!uninstall_cleanup::IsAttributedUserData(bare));

    // Tiered cleanup (no delete flag): rebuildables removed, preferences and browser data kept.
    const std::wstring cacheDir = userData + L"\\Cache";
    const std::wstring partitionCache = userData + L"\\Partitions\\worker_1\\GPUCache";
    const std::wstring partitionData = userData + L"\\Partitions\\worker_1\\IndexedDB";
    const std::wstring updater = root + L"\\rivetdeck-updater";
    const std::wstring report = root + L"\\residue.log";
    Mkdir(cacheDir);
    File(cacheDir + L"\\data_0");
    Mkdir(userData + L"\\Partitions");
    Mkdir(userData + L"\\Partitions\\worker_1");
    Mkdir(partitionCache);
    File(partitionCache + L"\\gpu.bin");
    Mkdir(partitionData);
    File(partitionData + L"\\db.leveldb");
    File(userData + L"\\desktop-preferences.json");
    File(userData + L"\\Cookies");
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
        assert(!Exists(userData + L"\\electron"));
        assert(!Exists(cacheDir));
        assert(!Exists(partitionCache));
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
    const std::wstring cache3 = userData3 + L"\\Cache";
    Mkdir(cache3);
    Mkdir(junctionTarget);
    File(junctionTarget + L"\\keep.me");
    assert(MakeJunction(cache3 + L"\\linked", junctionTarget));
    {
        const std::wstring missingHistory = root + L"\\missing.ini";
        uninstall_cleanup::CleanupRequest request;
        request.userData = userData3.c_str();
        request.installation = installation.c_str();
        request.protectedHome = L"";
        request.historyFile = missingHistory.c_str();
        request.updaterCache = updater.c_str();
        request.residueReport = report.c_str();
        assert(uninstall_cleanup::Cleanup(request) == ERROR_SUCCESS);
        assert(!Exists(cache3));
        assert(Exists(junctionTarget + L"\\keep.me"));
    }

    assert(RemoveDirectoryW(installation.c_str()));
}
