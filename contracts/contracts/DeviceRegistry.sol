// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title DeviceRegistry
/// @notice On-chain identity for physical energy meters. Each meter holds its own
///         secp256k1 key (ideally inside a secure element); only readings signed by a
///         registered, active key can ever become a certificate.
contract DeviceRegistry is AccessControl {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    struct Device {
        address owner;        // producer who receives certificates
        int32 latE6;          // latitude  * 1e6 (used by verifiers for irradiance lookup)
        int32 lonE6;          // longitude * 1e6
        uint32 capacityW;     // nameplate DC capacity in watts (hard physical cap)
        uint64 registeredAt;
        bool active;
        string name;          // human-readable site name
    }

    mapping(address => Device) private _devices;
    address[] private _deviceList;

    event DeviceRegistered(address indexed device, address indexed owner, uint32 capacityW, int32 latE6, int32 lonE6, string name);
    event DeviceStatusChanged(address indexed device, bool active, string reason);

    error AlreadyRegistered(address device);
    error UnknownDevice(address device);
    error InvalidParams();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
    }

    function registerDevice(
        address device,
        address owner,
        int32 latE6,
        int32 lonE6,
        uint32 capacityW,
        string calldata name
    ) external onlyRole(REGISTRAR_ROLE) {
        if (device == address(0) || owner == address(0) || capacityW == 0) revert InvalidParams();
        if (latE6 < -90_000_000 || latE6 > 90_000_000 || lonE6 < -180_000_000 || lonE6 > 180_000_000) revert InvalidParams();
        if (_devices[device].registeredAt != 0) revert AlreadyRegistered(device);

        _devices[device] = Device(owner, latE6, lonE6, capacityW, uint64(block.timestamp), true, name);
        _deviceList.push(device);
        emit DeviceRegistered(device, owner, capacityW, latE6, lonE6, name);
    }

    /// @notice Revoke (e.g. key compromise, tampering detected) or reinstate a meter.
    function setActive(address device, bool active, string calldata reason) external onlyRole(REGISTRAR_ROLE) {
        if (_devices[device].registeredAt == 0) revert UnknownDevice(device);
        _devices[device].active = active;
        emit DeviceStatusChanged(device, active, reason);
    }

    function getDevice(address device) external view returns (Device memory) {
        return _devices[device];
    }

    function isActive(address device) external view returns (bool) {
        return _devices[device].active;
    }

    function deviceCount() external view returns (uint256) {
        return _deviceList.length;
    }

    function deviceAt(uint256 i) external view returns (address) {
        return _deviceList[i];
    }

    function allDevices() external view returns (address[] memory) {
        return _deviceList;
    }
}
